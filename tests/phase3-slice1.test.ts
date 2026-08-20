import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { encodeSessionCookie, SESSION_COOKIE } from "../src/auth/session-cookie.js";
import { loadConfig } from "../src/config.js";
import { accounts } from "../src/db/schema.js";
import { loadOrCreateJwks } from "../src/db/jwks.js";
import { DomainError } from "../src/domain/errors.js";
import { upsertAccountByClerkUser } from "../src/domain/identity.js";
import {
  getAccountPlatformRole,
  requirePlatformAdmin,
} from "../src/domain/platform-admin.js";
import { createHttpServer } from "../src/server.js";
import { obtainOAuthAccessToken } from "./helpers-oauth-token.js";
import { makeGrantPrincipal, suffix, testDb } from "./helpers.js";
import { mintScriptToken } from "../src/auth/script-token.js";

type HttpResult = {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
};

function httpRequest(
  port: number,
  host: string,
  path: string,
  options: { method?: string; cookie?: string; authorization?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host };
    if (options.cookie) headers.cookie = options.cookie;
    if (options.authorization) headers.authorization = options.authorization;
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

function sessionCookie(accountId: string, cookieKey: string): string {
  return `${SESSION_COOKIE}=${encodeSessionCookie(accountId, cookieKey)}`;
}

test("new accounts default to platform_role=user", async () => {
  const db = await testDb();
  const tag = suffix();
  const identity = await upsertAccountByClerkUser(db, {
    clerkUserId: `role_default_${tag}`,
    email: `${tag}@example.test`,
  });
  assert.equal(await getAccountPlatformRole(db, identity.account_id), "user");
});

test("invalid platform_role values are rejected by the database", async () => {
  const db = await testDb();
  const tag = suffix();
  const identity = await upsertAccountByClerkUser(db, {
    clerkUserId: `role_invalid_${tag}`,
    email: `${tag}@example.test`,
  });
  await assert.rejects(async () => {
    await db
      .update(accounts)
      .set({ platformRole: "superuser" })
      .where(eq(accounts.id, identity.account_id));
  });
});

test("requirePlatformAdmin denies normal users and allows admins", async () => {
  const db = await testDb();
  const tag = suffix();
  const user = await upsertAccountByClerkUser(db, {
    clerkUserId: `role_user_${tag}`,
    email: `user_${tag}@example.test`,
  });
  const admin = await upsertAccountByClerkUser(db, {
    clerkUserId: `role_admin_${tag}`,
    email: `admin_${tag}@example.test`,
  });
  await db.update(accounts).set({ platformRole: "admin" }).where(eq(accounts.id, admin.account_id));

  await assert.rejects(
    () => requirePlatformAdmin(db, user.account_id),
    (error: unknown) => error instanceof DomainError && error.status === 403,
  );
  await requirePlatformAdmin(db, admin.account_id);
});

test("Slice 1: /admin on portal host returns 401 without session", async () => {
  await withServer(async (port, config) => {
    const res = await httpRequest(port, config.portalHost, "/admin");
    assert.equal(res.status, 401);
    const json = JSON.parse(res.body) as { error: string };
    assert.equal(json.error, "unauthorized");
  });
});

test("Slice 1: /admin on portal host returns 403 for normal user", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const user = await upsertAccountByClerkUser(db, {
      clerkUserId: `portal_user_${tag}`,
      email: `portal_user_${tag}@example.test`,
    });
    const res = await httpRequest(port, config.portalHost, "/admin", {
      cookie: sessionCookie(user.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 403);
    const json = JSON.parse(res.body) as { error: string };
    assert.equal(json.error, "forbidden");
  });
});

test("Slice 1: /admin on portal host returns 200 for platform admin", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const admin = await upsertAccountByClerkUser(db, {
      clerkUserId: `portal_admin_${tag}`,
      email: `portal_admin_${tag}@example.test`,
    });
    await db.update(accounts).set({ platformRole: "admin" }).where(eq(accounts.id, admin.account_id));
    const res = await httpRequest(port, config.portalHost, "/admin", {
      cookie: sessionCookie(admin.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.match(res.body, /ReachMy Admin/);
    assert.match(res.body, /Platform administration/);
  });
});

test("Slice 1: /admin rejects MCP/OAuth bearer token even for platform admin account", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const { identity } = await makeGrantPrincipal(db, "oauth_admin", "Claude");
    await db.update(accounts).set({ platformRole: "admin" }).where(eq(accounts.id, identity.account_id));
    const oauthToken = await obtainOAuthAccessToken(port, config, identity.account_id);
    const res = await httpRequest(port, config.portalHost, "/admin", {
      authorization: `Bearer ${oauthToken}`,
    });
    assert.equal(res.status, 401);
    const json = JSON.parse(res.body) as { error: string };
    assert.equal(json.error, "unauthorized");
  });
});

test("Slice 1: /admin rejects script bearer token even for platform admin account", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const admin = await upsertAccountByClerkUser(db, {
      clerkUserId: `script_admin_${tag}`,
      email: `script_admin_${tag}@example.test`,
    });
    await db.update(accounts).set({ platformRole: "admin" }).where(eq(accounts.id, admin.account_id));
    const scriptToken = mintScriptToken(admin.account_id, config.cookieKeys[0]!);
    const res = await httpRequest(port, config.portalHost, "/admin", {
      authorization: `Bearer ${scriptToken}`,
    });
    assert.equal(res.status, 401);
    const json = JSON.parse(res.body) as { error: string };
    assert.equal(json.error, "unauthorized");
  });
});

test("Slice 1: /admin is not available on MCP host", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const admin = await upsertAccountByClerkUser(db, {
      clerkUserId: `mcp_admin_${tag}`,
      email: `mcp_admin_${tag}@example.test`,
    });
    await db.update(accounts).set({ platformRole: "admin" }).where(eq(accounts.id, admin.account_id));
    const mcpHost = new URL(config.publicUrl).hostname;
    const res = await httpRequest(port, mcpHost, "/admin", {
      cookie: sessionCookie(admin.account_id, config.cookieKeys[0]!),
    });
    assert.notEqual(res.status, 200);
  });
});
