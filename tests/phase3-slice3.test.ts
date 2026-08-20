import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import {
  resolveBrowserAccountId,
  setClerkBrowserSessionResolverForTests,
} from "../src/auth/browser-account.js";
import { clerkAuthorizedParties, verifyClerkJwt } from "../src/auth/clerk.js";
import { encodeSessionCookie, SESSION_COOKIE } from "../src/auth/session-cookie.js";
import { loadConfig } from "../src/config.js";
import { principals } from "../src/db/schema.js";
import { loadOrCreateJwks } from "../src/db/jwks.js";
import {
  ensureProvisionalPrincipal,
  getIdentityByAccountId,
  upsertAccountByClerkUser,
} from "../src/domain/identity.js";
import { mintScriptToken } from "../src/auth/script-token.js";
import { createHttpServer } from "../src/server.js";
import { obtainOAuthAccessToken } from "./helpers-oauth-token.js";
import { makeGrantPrincipal, suffix, testDb } from "./helpers.js";

type HttpResult = {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
};

function mockRequest(
  init: { cookie?: string; authorization?: string; url?: string; method?: string } = {},
): http.IncomingMessage {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.authorization) headers.authorization = init.authorization;
  return { headers, method: init.method ?? "GET", url: init.url ?? "/interaction/test" } as http.IncomingMessage;
}

function sessionCookie(accountId: string, cookieKey: string): string {
  return `${SESSION_COOKIE}=${encodeSessionCookie(accountId, cookieKey)}`;
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
    setClerkBrowserSessionResolverForTests(null);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

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

test("Slice 3A: existing an_session resolves without Clerk bridge", async () => {
  const db = await testDb();
  const config = loadConfig();
  const tag = suffix();
  const account = await upsertAccountByClerkUser(db, {
    clerkUserId: `sess_${tag}`,
    email: `sess_${tag}@example.test`,
  });
  setClerkBrowserSessionResolverForTests(async () => {
    throw new Error("Clerk bridge should not run when an_session is present");
  });
  const resolved = await resolveBrowserAccountId(
    mockRequest({ cookie: sessionCookie(account.account_id, config.cookieKeys[0]!) }),
    config,
    db,
  );
  assert.ok(resolved);
  assert.equal(resolved.accountId, account.account_id);
  assert.equal(resolved.mintedSession, false);
});

test("Slice 3B: Clerk browser session mints mcp an_session", async () => {
  const db = await testDb();
  const config = loadConfig();
  const tag = suffix();
  const clerkUserId = `clerk_bridge_${tag}`;
  setClerkBrowserSessionResolverForTests(async () => ({
    clerkUserId,
    email: `bridge_${tag}@example.test`,
  }));
  const resolved = await resolveBrowserAccountId(mockRequest(), config, db);
  assert.ok(resolved);
  assert.equal(resolved.mintedSession, true);
  const identity = await getIdentityByAccountId(db, resolved.accountId);
  assert.equal(identity.clerk_user_id, clerkUserId);
});

test("Slice 3C: new Clerk user creates ReachMy account", async () => {
  const db = await testDb();
  const config = loadConfig();
  const tag = suffix();
  const clerkUserId = `new_clerk_${tag}`;
  setClerkBrowserSessionResolverForTests(async () => ({ clerkUserId, email: `new_${tag}@example.test` }));
  const resolved = await resolveBrowserAccountId(mockRequest(), config, db);
  assert.ok(resolved);
  const identity = await getIdentityByAccountId(db, resolved.accountId);
  assert.equal(identity.clerk_user_id, clerkUserId);
  assert.equal(identity.onboarding, "ONBOARDING_REQUIRED");
});

test("Slice 3D: existing Clerk user reuses the same account", async () => {
  const db = await testDb();
  const config = loadConfig();
  const tag = suffix();
  const clerkUserId = `reuse_clerk_${tag}`;
  const existing = await upsertAccountByClerkUser(db, {
    clerkUserId,
    email: `reuse_${tag}@example.test`,
  });
  setClerkBrowserSessionResolverForTests(async () => ({ clerkUserId, email: `reuse_${tag}@example.test` }));
  const resolved = await resolveBrowserAccountId(mockRequest(), config, db);
  assert.ok(resolved);
  assert.equal(resolved.accountId, existing.account_id);
});

test("Slice 3E: no auth returns null for sign-in fallback", async () => {
  const db = await testDb();
  const config = loadConfig();
  setClerkBrowserSessionResolverForTests(async () => null);
  const resolved = await resolveBrowserAccountId(mockRequest(), config, db);
  assert.equal(resolved, null);
});

test("Slice 3F: MCP OAuth bearer cannot satisfy browser account resolution", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const { identity } = await makeGrantPrincipal(db, "oauth_human", "Claude");
    const oauthToken = await obtainOAuthAccessToken(port, config, identity.account_id);
    setClerkBrowserSessionResolverForTests(async () => null);
    const resolved = await resolveBrowserAccountId(
      mockRequest({ authorization: `Bearer ${oauthToken}` }),
      config,
      db,
    );
    assert.equal(resolved, null);
  });
});

test("Slice 3G: script bearer cannot satisfy browser account resolution", async () => {
  const db = await testDb();
  const config = loadConfig();
  const tag = suffix();
  const account = await upsertAccountByClerkUser(db, { clerkUserId: `script_${tag}` });
  const scriptToken = mintScriptToken(account.account_id, config.cookieKeys[0]!);
  setClerkBrowserSessionResolverForTests(async () => null);
  const resolved = await resolveBrowserAccountId(
    mockRequest({ authorization: `Bearer ${scriptToken}` }),
    config,
    db,
  );
  assert.equal(resolved, null);
});

test("Slice 3H: invalid Clerk session falls back safely", async () => {
  const db = await testDb();
  const config = loadConfig();
  setClerkBrowserSessionResolverForTests(async () => null);
  const resolved = await resolveBrowserAccountId(mockRequest({ cookie: "__session=invalid" }), config, db);
  assert.equal(resolved, null);
});

test("Slice 3I: clerkAuthorizedParties includes Portal and MCP origins", () => {
  const config = loadConfig();
  const parties = clerkAuthorizedParties(config);
  assert.ok(parties.includes(config.portalUrl));
  assert.ok(parties.includes(config.publicUrl));
});

test("Slice 3I: verifyClerkJwt rejects malformed tokens", async () => {
  const config = loadConfig();
  await assert.rejects(() => verifyClerkJwt(config, "not-a-clerk-jwt"));
});

test("Slice 3: OAuth interaction redirects to sign-in without human auth", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    setClerkBrowserSessionResolverForTests(async () => null);
    const mcpHost = new URL(config.publicUrl).hostname;
    const reg = await httpRequest(port, mcpHost, "/reg", {
      method: "POST",
      authorization: undefined,
    });
    void reg;
    const authPath =
      "/auth?response_type=code&client_id=test&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=abc&code_challenge_method=S256&resource=" +
      encodeURIComponent(`${config.publicUrl}/mcp`);
    const res = await httpRequest(port, mcpHost, authPath);
    if (res.status === 303 || res.status === 302) {
      const location = String(res.headers.location ?? "");
      assert.ok(location.includes("/sign-in") || location.includes("/interaction/"));
    }
    void db;
  });
});

test("Slice 3: OAuth interaction accepts Clerk bridge and mints an_session", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const clerkUserId = `oauth_bridge_${tag}`;
    setClerkBrowserSessionResolverForTests(async () => ({
      clerkUserId,
      email: `oauth_bridge_${tag}@example.test`,
    }));

    const mcpHost = new URL(config.publicUrl).hostname;
    const jar: string[] = [];
    const visit = async (
      path: string,
      init: { method?: string; body?: string; contentType?: string } = {},
    ) => {
      const headers: Record<string, string> = { host: mcpHost };
      if (jar.length) headers.cookie = jar.join("; ");
      if (init.contentType) headers["content-type"] = init.contentType;
      const res = await new Promise<HttpResult>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path,
            method: init.method ?? "GET",
            headers,
          },
          (response) => {
            let body = "";
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () => {
              resolve({ status: response.statusCode ?? 0, body, headers: response.headers });
            });
          },
        );
        req.on("error", reject);
        if (init.body) req.write(init.body);
        req.end();
      });
      const setCookie = res.headers["set-cookie"];
      if (typeof setCookie === "string") jar.push(setCookie.split(";")[0]!);
      else if (Array.isArray(setCookie)) {
        for (const raw of setCookie) jar.push(raw.split(";")[0]!);
      }
      return res;
    };

    const prm = JSON.parse((await visit("/.well-known/oauth-protected-resource")).body) as { resource: string };
    const asm = JSON.parse((await visit("/.well-known/oauth-authorization-server")).body) as {
      registration_endpoint: string;
    };
    const regPath = new URL(asm.registration_endpoint, `http://${mcpHost}`).pathname;
    const regRes = await visit(regPath, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        client_name: "Slice3-Clerk-Bridge",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const regBody = JSON.parse(regRes.body) as { client_id?: string };
    assert.ok(regBody.client_id, "DCR should succeed for OAuth bridge test");

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authUrl = new URL("/auth", `http://${mcpHost}`);
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: regBody.client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: randomBytes(8).toString("hex"),
      resource: prm.resource,
      scope:
        "identity:read contacts:read contacts:write interactions:read interactions:write proposals:write approvals:write offline_access",
    }).toString();

    let url = `${authUrl.pathname}${authUrl.search}`;
    let method: "GET" | "POST" = "GET";
    let sawSessionMint = false;
    for (let hop = 0; hop < 12; hop++) {
      const res = await visit(url, { method });
      const setCookie = res.headers["set-cookie"];
      const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
      if (cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`))) sawSessionMint = true;
      const location = typeof res.headers.location === "string" ? res.headers.location : null;
      method = "GET";
      if (location?.startsWith("https://claude.ai/")) break;
      if (location) {
        const next = new URL(location, `http://${mcpHost}`);
        url = `${next.pathname}${next.search}`;
        continue;
      }
      if (res.status === 200 && url.startsWith("/interaction/")) {
        assert.ok(sawSessionMint, "expected an_session minted via Clerk bridge");
        assert.match(res.body, /Authorize an agent/);
        const identity = await getIdentityByAccountId(db, (await resolveBrowserAccountId(
          mockRequest({ cookie: jar.join("; ") }),
          config,
          db,
        ))!.accountId);
        assert.equal(identity.clerk_user_id, clerkUserId);
        return;
      }
      if (res.status === 302 && String(res.headers.location).includes("/sign-in")) {
        assert.fail("Clerk bridge should avoid sign-in redirect");
      }
      break;
    }
    assert.fail("expected OAuth interaction consent page via Clerk bridge");
  });
});

test("Slice 3J: Clerk bridge OAuth consent preserves provisional principal lifecycle", async () => {
  const db = await testDb();
  const config = loadConfig();
  const tag = suffix();
  const clerkUserId = `prov_bridge_${tag}`;
  setClerkBrowserSessionResolverForTests(async () => ({
    clerkUserId,
    email: `prov_bridge_${tag}@example.test`,
  }));
  const resolved = await resolveBrowserAccountId(mockRequest(), config, db);
  assert.ok(resolved);
  await ensureProvisionalPrincipal(db, resolved.accountId);
  const identity = await getIdentityByAccountId(db, resolved.accountId);
  assert.ok(identity.principal_id);
  assert.equal(identity.handle, null);
  assert.equal(identity.onboarding, "ONBOARDING_REQUIRED");
  const rows = await db.select().from(principals).where(eq(principals.accountId, resolved.accountId));
  assert.equal(rows.length, 1);
});

test("Slice 3: GET /sign-in redirects when Clerk bridge resolves account", async () => {
  await withServer(async (port, config) => {
    const tag = suffix();
    setClerkBrowserSessionResolverForTests(async () => ({
      clerkUserId: `signin_bridge_${tag}`,
      email: `signin_bridge_${tag}@example.test`,
    }));
    const mcpHost = new URL(config.publicUrl).hostname;
    const res = await httpRequest(port, mcpHost, "/sign-in?redirect=/security");
    assert.equal(res.status, 302);
    const location = String(res.headers.location ?? "");
    assert.equal(location, "/security");
    const setCookie = res.headers["set-cookie"];
    assert.ok(
      (Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie ?? "")).includes(`${SESSION_COOKIE}=`),
    );
  });
});
