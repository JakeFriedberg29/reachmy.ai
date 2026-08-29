/**
 * Grant rebind: ChatGPT reconnect issues Grant B while `agent_connections` still holds Grant A
 * for the same OAuth client. `/mcp` must rebind that row, not 401.
 */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { test } from "node:test";
import { setClerkBrowserSessionResolverForTests } from "../src/auth/browser-account.js";
import { hostnameFromUrl, type AppConfig } from "../src/config.js";
import { CONNECTION_REVOKED } from "../src/domain/connections.js";
import { agentConnections, oauthModels } from "../src/db/schema.js";
import { upsertGrantConnection } from "../src/domain/identity.js";
import { httpRequest, withServerOnPublicUrlPort } from "./helpers-http.js";
import { createOauthSession } from "./helpers-oauth-token.js";
import { makePrincipal, suffix, testDb } from "./helpers.js";

const MCP_ACCEPT = "application/json, text/event-stream";
const CHATGPT_REDIRECT = "https://chatgpt.com/connector/oauth/grant-rebind-test";

type McpLog = Record<string, unknown>;

function captureMcpLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: McpLog[] }> {
  const logs: McpLog[] = [];
  const original = console.log;
  console.log = ((msg: unknown, ...rest: unknown[]) => {
    if (typeof msg === "string") {
      try {
        const parsed = JSON.parse(msg) as McpLog;
        if (parsed.msg === "mcp_debug") logs.push(parsed);
      } catch {
        // not structured mcp output
      }
    }
    return original.call(console, msg, ...rest);
  }) as typeof console.log;
  return fn()
    .then((result) => ({ result, logs }))
    .finally(() => {
      console.log = original;
    });
}

async function approveUntilCallback(
  session: ReturnType<typeof createOauthSession>,
  clientId: string,
) {
  let stop = await session.authorize({
    clientId,
    redirectUri: CHATGPT_REDIRECT,
    scope: "identity:read interactions:write",
  });
  for (let approvals = 0; stop.kind === "interaction" && approvals < 4; approvals++) {
    const allow = stop.formActions[0];
    if (!allow) throw new Error("missing consent form");
    stop = await session.submit(allow);
  }
  assert.equal(stop.kind, "callback");
  assert.ok(stop.kind === "callback" && stop.code);
  const tokens = await session.exchange({ clientId, code: stop.code!, resource: undefined });
  assert.equal(typeof tokens.access_token, "string");
  return tokens.access_token as string;
}

function mcpIdentityCall(port: number, config: AppConfig, token: string) {
  return httpRequest(port, hostnameFromUrl(config.publicUrl), "/mcp", {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_my_identity", arguments: {} },
    }),
    headers: {
      accept: MCP_ACCEPT,
      authorization: `Bearer ${token}`,
    },
  });
}

test("upsertGrantConnection rebinds a connected client to a new grant without duplicating the row", async () => {
  const db = await testDb();
  const { identity } = await makePrincipal(db, "rebind_unit");
  const clientId = `client_${suffix()}`;
  const grantA = `grant_a_${suffix()}`;
  const grantB = `grant_b_${suffix()}`;
  const staleAuthorizedAt = new Date("2026-08-20T00:00:00.000Z");

  const connectionId = await upsertGrantConnection(db, {
    principalId: identity.principal_id!,
    grantId: grantA,
    oauthClientId: clientId,
    displayLabel: "ChatGPT",
  });
  await db
    .update(agentConnections)
    .set({ lastAuthorizedAt: staleAuthorizedAt })
    .where(eq(agentConnections.id, connectionId));

  const reboundId = await upsertGrantConnection(db, {
    principalId: identity.principal_id!,
    grantId: grantB,
    oauthClientId: clientId,
    displayLabel: "ChatGPT",
  });
  assert.equal(reboundId, connectionId);

  const rows = await db.select().from(agentConnections).where(eq(agentConnections.oauthClientId, clientId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, connectionId);
  assert.equal(rows[0]!.grantId, grantB);
  assert.equal(rows[0]!.status, "connected");
  assert.ok(rows[0]!.lastAuthorizedAt && rows[0]!.lastAuthorizedAt.getTime() > staleAuthorizedAt.getTime());
});

test("upsertGrantConnection does not resurrect a revoked client connection", async () => {
  const db = await testDb();
  const { identity } = await makePrincipal(db, "rebind_revoked");
  const clientId = `client_${suffix()}`;
  const grantA = `grant_a_${suffix()}`;
  const grantB = `grant_b_${suffix()}`;

  const connectionId = await upsertGrantConnection(db, {
    principalId: identity.principal_id!,
    grantId: grantA,
    oauthClientId: clientId,
    displayLabel: "ChatGPT",
  });
  await db
    .update(agentConnections)
    .set({ status: CONNECTION_REVOKED, isPrimary: false })
    .where(eq(agentConnections.id, connectionId));

  await assert.rejects(
    () =>
      upsertGrantConnection(db, {
        principalId: identity.principal_id!,
        grantId: grantB,
        oauthClientId: clientId,
        displayLabel: "ChatGPT",
      }),
    (error: unknown) => error instanceof Error && /revoked/i.test(error.message),
  );

  const [row] = await db.select().from(agentConnections).where(eq(agentConnections.id, connectionId));
  assert.equal(row?.status, CONNECTION_REVOKED);
  assert.equal(row?.grantId, grantA);
});

test("upsertGrantConnection does not rebind B back to A when cleanup of A failed and A remains valid", async () => {
  const db = await testDb();
  const { identity } = await makePrincipal(db, "rebind_stale_a");
  const clientId = `client_${suffix()}`;
  const grantA = `grant_a_${suffix()}`;
  const grantB = `grant_b_${suffix()}`;

  await db.insert(oauthModels).values([
    { model: "Grant", id: grantA, payload: { clientId, iat: 1_000_000 } },
    { model: "Grant", id: grantB, payload: { clientId, iat: 2_000_000 } },
  ]);

  const connectionId = await upsertGrantConnection(db, {
    principalId: identity.principal_id!,
    grantId: grantA,
    oauthClientId: clientId,
    displayLabel: "ChatGPT",
  });
  const reboundId = await upsertGrantConnection(db, {
    principalId: identity.principal_id!,
    grantId: grantB,
    oauthClientId: clientId,
    displayLabel: "ChatGPT",
  });
  assert.equal(reboundId, connectionId);

  // Cleanup of A failed: the Grant A row is still valid.
  await db.insert(oauthModels).values({
    model: "Grant",
    id: grantA,
    payload: { clientId, iat: 1_000_000 },
  });

  await assert.rejects(
    () =>
      upsertGrantConnection(db, {
        principalId: identity.principal_id!,
        grantId: grantA,
        oauthClientId: clientId,
        displayLabel: "ChatGPT",
      }),
    (error: unknown) => error instanceof Error && /revoked/i.test(error.message),
  );

  const [row] = await db.select().from(agentConnections).where(eq(agentConnections.id, connectionId));
  assert.equal(row?.grantId, grantB);
  assert.equal(row?.status, "connected");

  const [liveB] = await db
    .select()
    .from(oauthModels)
    .where(and(eq(oauthModels.model, "Grant"), eq(oauthModels.id, grantB)));
  assert.ok(liveB);

  const extras = await db.select().from(agentConnections).where(eq(agentConnections.oauthClientId, clientId));
  assert.equal(extras.length, 1);
});

test("upsertGrantConnection refreshes last_authorized_at when the exact grant already exists", async () => {
  const db = await testDb();
  const { identity } = await makePrincipal(db, "rebind_same");
  const clientId = `client_${suffix()}`;
  const grantA = `grant_a_${suffix()}`;
  const staleAuthorizedAt = new Date("2026-08-20T00:00:00.000Z");

  const connectionId = await upsertGrantConnection(db, {
    principalId: identity.principal_id!,
    grantId: grantA,
    oauthClientId: clientId,
    displayLabel: "ChatGPT",
  });
  await db
    .update(agentConnections)
    .set({ lastAuthorizedAt: staleAuthorizedAt })
    .where(eq(agentConnections.id, connectionId));

  const again = await upsertGrantConnection(db, {
    principalId: identity.principal_id!,
    grantId: grantA,
    oauthClientId: clientId,
    displayLabel: "ChatGPT",
  });
  assert.equal(again, connectionId);
  const [row] = await db.select().from(agentConnections).where(eq(agentConnections.id, connectionId));
  assert.equal(row?.grantId, grantA);
  assert.ok(row?.lastAuthorizedAt && row.lastAuthorizedAt.getTime() > staleAuthorizedAt.getTime());
});

test("POST /mcp rebinds Grant A to Grant B and completes the tool call", async () => {
  await withServerOnPublicUrlPort(async (port, config: AppConfig) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const db = await testDb();
    const { identity } = await makePrincipal(db, "rebind_http");
    const session = createOauthSession(port, config, identity.account_id);
    const clientId = await session.register({
      client_name: "ChatGPT",
      redirect_uris: [CHATGPT_REDIRECT],
    });

    const staleAuthorizedAt = new Date("2026-08-20T00:00:00.000Z");
    const grantA = `stale_grant_${suffix()}`;
    const connectionId = await upsertGrantConnection(db, {
      principalId: identity.principal_id!,
      grantId: grantA,
      oauthClientId: clientId,
      displayLabel: "ChatGPT",
    });
    await db
      .update(agentConnections)
      .set({ lastAuthorizedAt: staleAuthorizedAt })
      .where(eq(agentConnections.id, connectionId));
    await db.insert(oauthModels).values({
      model: "Grant",
      id: grantA,
      payload: { clientId, accountId: identity.account_id },
    });

    const accessToken = await approveUntilCallback(session, clientId);
    const payload = decodeJwt(accessToken);
    const grantB = typeof payload.grant_id === "string" ? payload.grant_id : null;
    assert.ok(grantB);
    assert.notEqual(grantB, grantA);
    assert.equal(payload.client_id, clientId);

    const { result: res, logs } = await captureMcpLogs(() => mcpIdentityCall(port, config, accessToken));
    assert.equal(res.status, 200);

    const verified = logs.find((entry) => entry.event === "mcp_token_verified");
    assert.equal(verified?.ok, true);
    assert.equal(verified?.failure_reason, null);
    assert.equal(verified?.grant_id, grantB);

    const rows = await db
      .select()
      .from(agentConnections)
      .where(
        and(eq(agentConnections.principalId, identity.principal_id!), eq(agentConnections.oauthClientId, clientId)),
      );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, connectionId);
    assert.equal(rows[0]!.grantId, grantB);
    assert.equal(rows[0]!.status, "connected");
    assert.ok(rows[0]!.lastAuthorizedAt && rows[0]!.lastAuthorizedAt.getTime() > staleAuthorizedAt.getTime());

    const [staleGrant] = await db
      .select()
      .from(oauthModels)
      .where(and(eq(oauthModels.model, "Grant"), eq(oauthModels.id, grantA)));
    assert.equal(staleGrant, undefined);

    const [liveGrant] = await db
      .select()
      .from(oauthModels)
      .where(and(eq(oauthModels.model, "Grant"), eq(oauthModels.id, grantB)));
    assert.ok(liveGrant);
  });
});

test("POST /mcp does not resurrect a revoked ChatGPT connection on reauthorization", async () => {
  await withServerOnPublicUrlPort(async (port, config: AppConfig) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const db = await testDb();
    const { identity } = await makePrincipal(db, "rebind_http_rev");
    const session = createOauthSession(port, config, identity.account_id);
    const clientId = await session.register({
      client_name: "ChatGPT",
      redirect_uris: [CHATGPT_REDIRECT],
    });

    const grantA = `revoked_grant_${suffix()}`;
    const connectionId = await upsertGrantConnection(db, {
      principalId: identity.principal_id!,
      grantId: grantA,
      oauthClientId: clientId,
      displayLabel: "ChatGPT",
    });
    await db
      .update(agentConnections)
      .set({ status: CONNECTION_REVOKED, isPrimary: false })
      .where(eq(agentConnections.id, connectionId));

    const accessToken = await approveUntilCallback(session, clientId);
    const { result: res, logs } = await captureMcpLogs(() => mcpIdentityCall(port, config, accessToken));
    assert.equal(res.status, 401);
    assert.match(res.body, /invalid_token/);

    const verified = logs.find((entry) => entry.event === "mcp_token_verified");
    assert.equal(verified?.ok, false);
    assert.equal(verified?.failure_reason, "revoked_connection");

    const [row] = await db.select().from(agentConnections).where(eq(agentConnections.id, connectionId));
    assert.equal(row?.status, CONNECTION_REVOKED);
    assert.equal(row?.grantId, grantA);
    const extras = await db
      .select()
      .from(agentConnections)
      .where(eq(agentConnections.oauthClientId, clientId));
    assert.equal(extras.length, 1);
  });
});

test("POST /mcp inserts a first-time client/grant and accepts a later call with the same grant", async () => {
  await withServerOnPublicUrlPort(async (port, config: AppConfig) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const db = await testDb();
    const { identity } = await makePrincipal(db, "rebind_first");
    const session = createOauthSession(port, config, identity.account_id);
    const clientId = await session.register({
      client_name: "ChatGPT",
      redirect_uris: [CHATGPT_REDIRECT],
    });

    const accessToken = await approveUntilCallback(session, clientId);
    const grantId = decodeJwt(accessToken).grant_id;
    assert.equal(typeof grantId, "string");

    const first = await mcpIdentityCall(port, config, accessToken);
    assert.equal(first.status, 200);
    const second = await mcpIdentityCall(port, config, accessToken);
    assert.equal(second.status, 200);

    const rows = await db
      .select()
      .from(agentConnections)
      .where(
        and(eq(agentConnections.principalId, identity.principal_id!), eq(agentConnections.oauthClientId, clientId)),
      );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.grantId, grantId);
    assert.equal(rows[0]!.status, "connected");
  });
});
