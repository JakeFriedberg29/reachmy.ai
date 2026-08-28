import assert from "node:assert/strict";
import { test } from "node:test";
import { mintScriptToken } from "../src/auth/script-token.js";
import { loadConfig } from "../src/config.js";
import { upsertAccountByClerkUser } from "../src/domain/identity.js";
import { portalSignInClientScript, renderPortalSignIn } from "../src/http/portal-ui.js";
import { httpRequest, sessionCookie, withServer } from "./helpers-http.js";
import { obtainOAuthAccessToken } from "./helpers-oauth-token.js";
import { makeGrantPrincipal, suffix, testDb } from "./helpers.js";

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
