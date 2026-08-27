import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { mintScriptToken } from "../src/auth/script-token.js";
import { encodeSessionCookie, SESSION_COOKIE } from "../src/auth/session-cookie.js";
import { loadConfig } from "../src/config.js";
import { agentConnections, oauthModels } from "../src/db/schema.js";
import { loadOrCreateJwks } from "../src/db/jwks.js";
import {
  createIdentity,
  ensureProvisionalPrincipal,
  getIdentityByAccountId,
  upsertAccountByClerkUser,
  upsertGrantConnection,
} from "../src/domain/identity.js";
import { listPortalAiConnections } from "../src/domain/portal-connections.js";
import { isPortalHostAllowedPath } from "../src/http/host.js";
import { mintPortalCsrfToken } from "../src/http/portal-csrf.js";
import { createHttpServer } from "../src/server.js";
import { obtainOAuthAccessToken } from "./helpers-oauth-token.js";
import { makeGrantPrincipal, suffix, testDb } from "./helpers.js";

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
  options: {
    method?: string;
    cookie?: string;
    authorization?: string;
    body?: string;
    contentType?: string;
    origin?: string;
    csrf?: string;
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host };
    if (options.cookie) headers.cookie = options.cookie;
    if (options.authorization) headers.authorization = options.authorization;
    if (options.contentType) headers["content-type"] = options.contentType;
    if (options.origin) headers.origin = options.origin;
    if (options.csrf) headers["x-csrf-token"] = options.csrf;
    if (options.body) headers["content-length"] = String(Buffer.byteLength(options.body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers,
      },
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
    if (options.body) req.write(options.body);
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
  },
) {
  const clientId = input.grantId;
  await seedOauthClient(db, clientId, input.clientPayload);
  const connectionId = await upsertGrantConnection(db, {
    principalId,
    grantId: input.grantId,
    oauthClientId: clientId,
    displayLabel: "MCP",
  });
  if (input.status && input.status !== "connected") {
    await db
      .update(agentConnections)
      .set({ status: input.status })
      .where(eq(agentConnections.id, connectionId));
  }
  return connectionId;
}

test("Slice 8: home shows active Disconnect control and modal when connected", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const handle = `disc_ui_${tag}`.slice(0, 30);
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `disc_home_${tag}` });
    const identity = await createIdentity(db, account.account_id, { handle, displayName: "Disc" });
    await seedAiConnection(db, identity.principal_id!, {
      clientPayload: { client_name: "Claude" },
      grantId: `grant_disc_ui_${tag}`,
    });
    const res = await httpRequest(port, config.portalHost, "/", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /data-disconnect-open="claude"/);
    assert.match(res.body, /rm-disconnect-modal/);
    assert.match(res.body, /rm-btn--danger/);
    assert.doesNotMatch(res.body, /Coming in a later slice/);
    assert.match(res.body, /x-csrf-token/);
  });
});

test("Slice 8: unauthenticated disconnect is rejected", async () => {
  await withServer(async (port, config) => {
    const res = await httpRequest(port, config.portalHost, "/v1/portal/connections/claude/disconnect", {
      method: "POST",
      origin: config.portalUrl,
      csrf: "nope",
      contentType: "application/json",
      body: "{}",
    });
    assert.equal(res.status, 401);
  });
});

test("Slice 8: CSRF rejection without valid token", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `csrf_bad_${tag}` });
    const res = await httpRequest(port, config.portalHost, "/v1/portal/connections/claude/disconnect", {
      method: "POST",
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
      origin: config.portalUrl,
      csrf: "invalid-token",
      contentType: "application/json",
      body: "{}",
    });
    assert.equal(res.status, 403);
    assert.match(res.body, /CSRF/i);
  });
});

test("Slice 8: Origin rejection", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `origin_bad_${tag}` });
    const csrf = mintPortalCsrfToken(account.account_id, config.cookieKeys[0]!);
    const res = await httpRequest(port, config.portalHost, "/v1/portal/connections/claude/disconnect", {
      method: "POST",
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
      origin: "https://evil.example",
      csrf,
      contentType: "application/json",
      body: "{}",
    });
    assert.equal(res.status, 403);
    assert.match(res.body, /origin/i);
  });
});

test("Slice 8: successful disconnect revokes all provider grants and preserves Agent Name", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const handle = `keep_${tag}`.slice(0, 30);
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `disc_ok_${tag}` });
    const identity = await createIdentity(db, account.account_id, { handle, displayName: "Keep" });
    const first = await seedAiConnection(db, identity.principal_id!, {
      clientPayload: { client_name: "Claude" },
      grantId: `grant_disc_a_${tag}`,
    });
    const second = await seedAiConnection(db, identity.principal_id!, {
      clientPayload: { client_name: "Claude" },
      grantId: `grant_disc_b_${tag}`,
    });
    await seedAiConnection(db, identity.principal_id!, {
      clientPayload: { client_name: "ChatGPT" },
      grantId: `grant_disc_gpt_${tag}`,
    });

    const csrf = mintPortalCsrfToken(account.account_id, config.cookieKeys[0]!);
    const res = await httpRequest(port, config.portalHost, "/v1/portal/connections/claude/disconnect", {
      method: "POST",
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
      origin: config.portalUrl,
      csrf,
      contentType: "application/json",
      body: "{}",
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body) as {
      ok: boolean;
      provider: string;
      revoked_count: number;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.provider, "claude");
    assert.equal(payload.revoked_count, 2);

    const [rowA] = await db.select().from(agentConnections).where(eq(agentConnections.id, first));
    const [rowB] = await db.select().from(agentConnections).where(eq(agentConnections.id, second));
    assert.equal(rowA?.status, "revoked");
    assert.equal(rowB?.status, "revoked");

    const after = await listPortalAiConnections(db, account.account_id);
    assert.equal(after.overview.connections.find((row) => row.provider === "claude")?.status, "not_connected");
    assert.equal(after.overview.connections.find((row) => row.provider === "chatgpt")?.status, "connected");
    assert.equal(after.overview.agent_name, `@${handle}`);
    assert.equal(after.overview.agent_name_status, "claimed");
    assert.equal(after.connectionIdsByProvider.claude.length, 0);
    assert.equal(after.connectionIdsByProvider.chatgpt.length, 1);

    const identityAfter = await getIdentityByAccountId(db, account.account_id);
    assert.equal(identityAfter.handle, handle);
    assert.equal(identityAfter.principal_id, identity.principal_id);
  });
});

test("Slice 8: disconnect works for provisional / unclaimed users", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `prov_disc_${tag}` });
    const identity = await ensureProvisionalPrincipal(db, account.account_id);
    await seedAiConnection(db, identity.principal_id!, {
      clientPayload: { client_name: "ChatGPT" },
      grantId: `grant_prov_disc_${tag}`,
    });
    const csrf = mintPortalCsrfToken(account.account_id, config.cookieKeys[0]!);
    const res = await httpRequest(port, config.portalHost, "/v1/portal/connections/chatgpt/disconnect", {
      method: "POST",
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
      origin: config.portalUrl,
      csrf,
      contentType: "application/json",
      body: "{}",
    });
    assert.equal(res.status, 200);
    const after = await listPortalAiConnections(db, account.account_id);
    assert.equal(after.overview.agent_name_status, "not_claimed");
    assert.equal(after.overview.connections.find((row) => row.provider === "chatgpt")?.status, "not_connected");
  });
});

test("Slice 8: disconnect is idempotent when already disconnected", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `idem_disc_${tag}` });
    const csrf = mintPortalCsrfToken(account.account_id, config.cookieKeys[0]!);
    const res = await httpRequest(port, config.portalHost, "/v1/portal/connections/claude/disconnect", {
      method: "POST",
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
      origin: config.portalUrl,
      csrf,
      contentType: "application/json",
      body: "{}",
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body) as { revoked_count: number; already_disconnected: boolean };
    assert.equal(payload.revoked_count, 0);
    assert.equal(payload.already_disconnected, true);
  });
});

test("Slice 8: MCP/script tokens cannot call disconnect", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const { identity } = await makeGrantPrincipal(db, "oauth_disc", "Claude");
    const oauthToken = await obtainOAuthAccessToken(port, config, identity.account_id);
    const script = mintScriptToken(identity.account_id, config.cookieKeys[0]!);
    const csrf = mintPortalCsrfToken(identity.account_id, config.cookieKeys[0]!);

    const oauthRes = await httpRequest(port, config.portalHost, "/v1/portal/connections/claude/disconnect", {
      method: "POST",
      authorization: `Bearer ${oauthToken}`,
      origin: config.portalUrl,
      csrf,
      contentType: "application/json",
      body: "{}",
    });
    assert.equal(oauthRes.status, 401);

    const scriptRes = await httpRequest(port, config.portalHost, "/v1/portal/connections/claude/disconnect", {
      method: "POST",
      authorization: `Bearer ${script}`,
      origin: config.portalUrl,
      csrf,
      contentType: "application/json",
      body: "{}",
    });
    assert.equal(scriptRes.status, 401);
  });
});

test("Slice 8: disconnect route is not exposed on MCP host", async () => {
  await withServer(async (port, config) => {
    const mcpHost = new URL(config.publicUrl).hostname;
    const res = await httpRequest(port, mcpHost, "/v1/portal/connections/claude/disconnect", {
      method: "POST",
      contentType: "application/json",
      body: "{}",
    });
    assert.notEqual(res.status, 200);
    assert.equal(isPortalHostAllowedPath("POST", "/v1/portal/connections/claude/disconnect"), true);
  });
});

test("Slice 8: Connect Claude/ChatGPT home actions remain for disconnected providers", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `home_disc_${tag}` });
    const res = await httpRequest(port, config.portalHost, "/", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /href="\/connect\/claude"/);
    assert.match(res.body, /href="\/connect\/chatgpt"/);
    assert.doesNotMatch(res.body, /data-disconnect-open="(?:claude|chatgpt)"/);
  });
});
