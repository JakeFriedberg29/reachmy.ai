import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { encodeSessionCookie, SESSION_COOKIE } from "../src/auth/session-cookie.js";
import { loadConfig } from "../src/config.js";
import { agentConnections, accounts, oauthModels } from "../src/db/schema.js";
import { loadOrCreateJwks } from "../src/db/jwks.js";
import {
  createIdentity,
  ensureApiConnection,
  ensureProvisionalPrincipal,
  upsertAccountByClerkUser,
  upsertGrantConnection,
} from "../src/domain/identity.js";
import {
  inferPortalProvider,
  listPortalAiConnections,
  toPortalOverviewResponse,
} from "../src/domain/portal-connections.js";
import { createHttpServer } from "../src/server.js";
import { isPortalHostAllowedPath } from "../src/http/host.js";
import { suffix, testDb } from "./helpers.js";

type HttpResult = {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
};

function sessionCookie(accountId: string, cookieKey: string): string {
  return `${SESSION_COOKIE}=${encodeSessionCookie(accountId, cookieKey)}`;
}

function httpRequest(
  port: number,
  host: string,
  path: string,
  options: { method?: string; cookie?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host };
    if (options.cookie) headers.cookie = options.cookie;
    const req = http.request(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function withServer(run: (port: number, config: ReturnType<typeof loadConfig>) => Promise<void>) {
  const config = loadConfig();
  const db = await testDb();
  const jwks = await loadOrCreateJwks(db);
  const server = await createHttpServer(config, db, jwks);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected server address");
  }
  try {
    await run(address.port, config);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function seedOauthClient(
  db: Awaited<ReturnType<typeof testDb>>,
  clientId: string,
  payload: { client_name?: string; redirect_uris?: string[] },
) {
  await db.insert(oauthModels).values({
    model: "Client",
    id: clientId,
    payload,
  });
}

async function seedAiConnection(
  db: Awaited<ReturnType<typeof testDb>>,
  principalId: string,
  input: {
    clientPayload: { client_name?: string; redirect_uris?: string[] };
    grantId: string;
    status?: string;
    label?: string;
  },
) {
  const clientId = input.grantId;
  await seedOauthClient(db, clientId, input.clientPayload);
  const connectionId = await upsertGrantConnection(db, {
    principalId,
    grantId: input.grantId,
    oauthClientId: clientId,
    displayLabel: input.label ?? "MCP",
  });
  if (input.status && input.status !== "connected") {
    await db
      .update(agentConnections)
      .set({ status: input.status })
      .where(eq(agentConnections.id, connectionId));
  }
  return connectionId;
}

function assertNoSensitiveFields(json: string) {
  assert.doesNotMatch(json, /grant_id|oauth_client_id|agent_connection_id|principal_id|account_id|clerk_user_id/i);
  assert.doesNotMatch(json, /"id"\s*:/);
  assert.doesNotMatch(json, /redirect_uri|client_name|client_secret|access_token|refresh_token/i);
}

test("inferPortalProvider detects Claude and ChatGPT from metadata", () => {
  assert.equal(inferPortalProvider({ client_name: "Claude" }), "claude");
  assert.equal(
    inferPortalProvider({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
    "claude",
  );
  assert.equal(inferPortalProvider({ client_name: "ChatGPT" }), "chatgpt");
  assert.equal(
    inferPortalProvider({ redirect_uris: ["https://chatgpt.com/connector/oauth/abc"] }),
    "chatgpt",
  );
  assert.equal(inferPortalProvider({ client_name: "OtherBot" }), null);
});

test("Slice 4: no principal returns both providers not connected", async () => {
  const db = await testDb();
  const tag = suffix();
  const account = await upsertAccountByClerkUser(db, { clerkUserId: `overview_${tag}` });
  const view = await listPortalAiConnections(db, account.account_id);
  assert.equal(view.overview.agent_name, null);
  assert.equal(view.overview.agent_name_status, "not_claimed");
  assert.deepEqual(view.overview.connections, [
    { provider: "claude", label: "Claude", status: "not_connected" },
    { provider: "chatgpt", label: "ChatGPT", status: "not_connected" },
  ]);
});

test("Slice 4: provisional principal + Claude shows not claimed and Claude connected", async () => {
  const db = await testDb();
  const tag = suffix();
  const account = await upsertAccountByClerkUser(db, { clerkUserId: `prov_overview_${tag}` });
  const provisional = await ensureProvisionalPrincipal(db, account.account_id);
  await seedAiConnection(db, provisional.principal_id!, {
    clientPayload: {
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    },
    grantId: `grant_claude_${tag}`,
  });
  const view = await listPortalAiConnections(db, account.account_id);
  assert.equal(view.overview.agent_name, null);
  assert.equal(view.overview.agent_name_status, "not_claimed");
  assert.equal(view.overview.connections[0]?.status, "connected");
  assert.equal(view.overview.connections[1]?.status, "not_connected");
});

test("Slice 4: claimed Agent Name returned correctly", async () => {
  const db = await testDb();
  const tag = suffix();
  const handle = `ov_${tag}`.slice(0, 30);
  const account = await upsertAccountByClerkUser(db, { clerkUserId: `claimed_overview_${tag}` });
  await createIdentity(db, account.account_id, { handle, displayName: "Overview User" });
  const view = await listPortalAiConnections(db, account.account_id);
  assert.equal(view.overview.agent_name, `@${handle}`);
  assert.equal(view.overview.agent_name_status, "claimed");
});

test("Slice 4: internal API connection filtered from Portal providers", async () => {
  const db = await testDb();
  const tag = suffix();
  const handle = `api_${tag}`.slice(0, 30);
  const account = await upsertAccountByClerkUser(db, { clerkUserId: `api_filter_${tag}` });
  const identity = await createIdentity(db, account.account_id, { handle, displayName: "API Filter" });
  await ensureApiConnection(db, identity.principal_id!);
  const view = await listPortalAiConnections(db, account.account_id);
  assert.ok(view.overview.connections.every((row) => row.provider === "claude" || row.provider === "chatgpt"));
  assert.ok(view.overview.connections.every((row) => row.label !== "API"));
});

test("Slice 4: multiple active Claude grants aggregate to one connected row", async () => {
  const db = await testDb();
  const tag = suffix();
  const handle = `agg_${tag}`.slice(0, 30);
  const account = await upsertAccountByClerkUser(db, { clerkUserId: `agg_${tag}` });
  const identity = await createIdentity(db, account.account_id, { handle, displayName: "Agg" });
  const first = await seedAiConnection(db, identity.principal_id!, {
    clientPayload: { client_name: "Claude" },
    grantId: `grant_a_${tag}`,
  });
  const second = await seedAiConnection(db, identity.principal_id!, {
    clientPayload: { client_name: "Claude" },
    grantId: `grant_b_${tag}`,
  });
  const view = await listPortalAiConnections(db, account.account_id);
  const claude = view.overview.connections.find((row) => row.provider === "claude");
  assert.equal(claude?.status, "connected");
  assert.equal(view.connectionIdsByProvider.claude.length, 2);
  assert.ok(view.connectionIdsByProvider.claude.includes(first));
  assert.ok(view.connectionIdsByProvider.claude.includes(second));
});

test("Slice 4: all provider grants revoked shows not connected", async () => {
  const db = await testDb();
  const tag = suffix();
  const handle = `rev_${tag}`.slice(0, 30);
  const account = await upsertAccountByClerkUser(db, { clerkUserId: `rev_all_${tag}` });
  const identity = await createIdentity(db, account.account_id, { handle, displayName: "Rev" });
  await seedAiConnection(db, identity.principal_id!, {
    clientPayload: { client_name: "ChatGPT" },
    grantId: `grant_rev_a_${tag}`,
    status: "revoked",
  });
  await seedAiConnection(db, identity.principal_id!, {
    clientPayload: { client_name: "ChatGPT" },
    grantId: `grant_rev_b_${tag}`,
    status: "revoked",
  });
  const view = await listPortalAiConnections(db, account.account_id);
  assert.equal(view.overview.connections.find((row) => row.provider === "chatgpt")?.status, "not_connected");
});

test("Slice 4: one active grant among revoked keeps provider connected", async () => {
  const db = await testDb();
  const tag = suffix();
  const handle = `mix_${tag}`.slice(0, 30);
  const account = await upsertAccountByClerkUser(db, { clerkUserId: `rev_mix_${tag}` });
  const identity = await createIdentity(db, account.account_id, { handle, displayName: "Mix" });
  await seedAiConnection(db, identity.principal_id!, {
    clientPayload: { client_name: "Claude" },
    grantId: `grant_mix_rev_${tag}`,
    status: "revoked",
  });
  await seedAiConnection(db, identity.principal_id!, {
    clientPayload: { client_name: "Claude" },
    grantId: `grant_mix_active_${tag}`,
    status: "connected",
  });
  const view = await listPortalAiConnections(db, account.account_id);
  assert.equal(view.overview.connections.find((row) => row.provider === "claude")?.status, "connected");
});

test("Slice 4: unknown provider metadata is omitted without leaking raw data", async () => {
  const db = await testDb();
  const tag = suffix();
  const handle = `unk_${tag}`.slice(0, 30);
  const account = await upsertAccountByClerkUser(db, { clerkUserId: `unknown_${tag}` });
  const identity = await createIdentity(db, account.account_id, { handle, displayName: "Unknown" });
  await seedAiConnection(db, identity.principal_id!, {
    clientPayload: {
      client_name: "MysteryBot",
      redirect_uris: ["https://evil.example/oauth/callback"],
    },
    grantId: `grant_unknown_${tag}`,
  });
  const view = await listPortalAiConnections(db, account.account_id);
  assert.equal(view.connectionIdsByProvider.claude.length, 0);
  assert.equal(view.connectionIdsByProvider.chatgpt.length, 0);
  assert.deepEqual(view.overview.connections, [
    { provider: "claude", label: "Claude", status: "not_connected" },
    { provider: "chatgpt", label: "ChatGPT", status: "not_connected" },
  ]);
  const json = JSON.stringify(toPortalOverviewResponse(view));
  assertNoSensitiveFields(json);
});

test("Slice 4: user only sees their own overview data", async () => {
  const db = await testDb();
  const tag = suffix();
  const handleA = `usera_${tag}`.slice(0, 30);
  const handleB = `userb_${tag}`.slice(0, 30);
  const accountA = await upsertAccountByClerkUser(db, { clerkUserId: `overview_a_${tag}` });
  const accountB = await upsertAccountByClerkUser(db, { clerkUserId: `overview_b_${tag}` });
  await createIdentity(db, accountA.account_id, { handle: handleA, displayName: "User A" });
  await createIdentity(db, accountB.account_id, { handle: handleB, displayName: "User B" });
  const viewA = await listPortalAiConnections(db, accountA.account_id);
  const viewB = await listPortalAiConnections(db, accountB.account_id);
  assert.equal(viewA.overview.agent_name, `@${handleA}`);
  assert.equal(viewB.overview.agent_name, `@${handleB}`);
  assert.notEqual(viewA.overview.agent_name, viewB.overview.agent_name);
});

test("Slice 4: GET /v1/portal/overview returns 401 without session", async () => {
  await withServer(async (port, config) => {
    const res = await httpRequest(port, config.portalHost, "/v1/portal/overview");
    assert.equal(res.status, 401);
    const json = JSON.parse(res.body) as { error: string };
    assert.equal(json.error, "unauthorized");
  });
});

test("Slice 4: authenticated user receives own Portal overview", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const handle = `portal_${tag}`.slice(0, 30);
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `portal_api_${tag}` });
    const identity = await createIdentity(db, account.account_id, { handle, displayName: "Portal API" });
    await seedAiConnection(db, identity.principal_id!, {
      clientPayload: { client_name: "Claude" },
      grantId: `grant_portal_${tag}`,
    });
    const res = await httpRequest(port, config.portalHost, "/v1/portal/overview", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assertNoSensitiveFields(res.body);
    const json = JSON.parse(res.body) as {
      agent_name: string;
      agent_name_status: string;
      connections: Array<{ provider: string; status: string }>;
    };
    assert.equal(json.agent_name, `@${handle}`);
    assert.equal(json.agent_name_status, "claimed");
    assert.equal(json.connections.find((row) => row.provider === "claude")?.status, "connected");
  });
});

test("Slice 4: platform admin overview is still self-scoped", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const admin = await upsertAccountByClerkUser(db, { clerkUserId: `admin_overview_${tag}` });
    await db.update(accounts).set({ platformRole: "admin" }).where(eq(accounts.id, admin.account_id));
    const res = await httpRequest(port, config.portalHost, "/v1/portal/overview", {
      cookie: sessionCookie(admin.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body) as { agent_name: null; agent_name_status: string };
    assert.equal(json.agent_name, null);
    assert.equal(json.agent_name_status, "not_claimed");
  });
});

test("Slice 4: overview unavailable on MCP host", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `mcp_overview_${tag}` });
    const mcpHost = new URL(config.publicUrl).hostname;
    const res = await httpRequest(port, mcpHost, "/v1/portal/overview", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.notEqual(res.status, 200);
  });
});

test("Slice 4: Portal host allowlist includes overview route", () => {
  assert.equal(isPortalHostAllowedPath("GET", "/v1/portal/overview"), true);
  assert.equal(isPortalHostAllowedPath("POST", "/v1/portal/overview"), false);
});

test("Slice 4: other /v1 routes remain blocked on Portal host", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `portal_v1_${tag}` });
    const res = await httpRequest(port, config.portalHost, "/v1/me", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 404);
  });
});
