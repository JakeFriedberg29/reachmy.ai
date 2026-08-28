import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { mintScriptToken } from "../src/auth/script-token.js";
import { encodeSessionCookie, SESSION_COOKIE } from "../src/auth/session-cookie.js";
import { loadConfig } from "../src/config.js";
import { loadOrCreateJwks } from "../src/db/jwks.js";
import { upsertAccountByClerkUser } from "../src/domain/identity.js";
import { portalSignInClientScript, renderPortalSignIn } from "../src/http/portal-ui.js";
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
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host };
    if (options.cookie) headers.cookie = options.cookie;
    if (options.authorization) headers.authorization = options.authorization;
    if (options.contentType) headers["content-type"] = options.contentType;
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

test("Portal sign-in script bridges Clerk session via addListener after mountSignIn", () => {
  const script = portalSignInClientScript("/connect/claude");
  assert.match(script, /Clerk\.addListener/);
  assert.match(script, /skipInitialEmit:\s*true/);
  assert.match(script, /bridgeReachMySession/);
  assert.match(script, /\/v1\/auth\/clerk/);
  assert.match(script, /method: "POST"/);
  assert.match(script, /Clerk\.mountSignIn/);
  assert.match(script, /if \(!Clerk\.user\)/);
  assert.match(script, /window\.location\.assign\(redirectTo\)/);
  assert.match(script, /"\/connect\/claude"/);
  assert.doesNotMatch(script, /mountSignIn[\s\S]*return;/);
});

test("Portal sign-in HTML embeds bridge script with redirect destination", () => {
  const config = loadConfig();
  const html = renderPortalSignIn(config, "/connect/chatgpt");
  assert.match(html, /Sign in to open your ReachMy Portal/);
  assert.match(html, /initPortalSignIn/);
  assert.match(html, /"\/connect\/chatgpt"/);
});

test("Portal sign-in: invalid Clerk token rejected at /v1/auth/clerk", async () => {
  await withServer(async (port, config) => {
    const res = await httpRequest(port, config.portalHost, "/v1/auth/clerk", {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ token: "not-a-clerk-jwt" }),
    });
    assert.equal(res.status, 401);
    assert.match(res.body, /unauthorized|Invalid/i);
    assert.equal(res.headers["set-cookie"], undefined);
  });
});

test("Portal sign-in: existing an_session skips sign-in and preserves redirect", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, {
      clerkUserId: `signin_skip_${tag}`,
      email: `signin_skip_${tag}@example.test`,
    });
    const res = await httpRequest(port, config.portalHost, "/sign-in?redirect=%2Fconnect%2Fclaude", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/connect/claude");
  });
});

test("Portal sign-in: bridged an_session opens Portal home without another sign-in redirect", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, {
      clerkUserId: `signin_home_${tag}`,
      email: `signin_home_${tag}@example.test`,
    });
    const cookie = sessionCookie(account.account_id, config.cookieKeys[0]!);
    const home = await httpRequest(port, config.portalHost, "/", { cookie });
    assert.equal(home.status, 200);
    assert.match(home.body, /Your AI Connections/);
    const signInAgain = await httpRequest(port, config.portalHost, "/sign-in", { cookie });
    assert.equal(signInAgain.status, 302);
    assert.equal(signInAgain.headers.location, "/");
  });
});

test("Portal sign-in: MCP OAuth bearer cannot authenticate Portal /v1/auth/clerk", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const { identity } = await makeGrantPrincipal(db, "oauth_clerk_auth", "Claude");
    const accessToken = await obtainOAuthAccessToken(port, config, identity.account_id);
    const res = await httpRequest(port, config.portalHost, "/v1/auth/clerk", {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ token: accessToken }),
    });
    assert.equal(res.status, 401);
  });
});

test("Portal sign-in: script bearer cannot authenticate Portal home", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `script_home_${tag}` });
    const scriptToken = mintScriptToken(account.account_id, config.cookieKeys[0]!);
    const res = await httpRequest(port, config.portalHost, "/", {
      authorization: `Bearer ${scriptToken}`,
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/sign-in");
  });
});
