/**
 * Diagnostic rollback of Slice 4 explicit consent. An authenticated ChatGPT-shaped
 * authorization must reach the callback without `/confirm` or `/deny`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setClerkBrowserSessionResolverForTests } from "../src/auth/browser-account.js";
import { upsertAccountByClerkUser } from "../src/domain/identity.js";
import { withServer } from "./helpers-http.js";
import { createOauthSession, type OauthStop } from "./helpers-oauth-token.js";
import { suffix, testDb } from "./helpers.js";

const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const CHATGPT_SCOPE = "identity:read interactions:write";

async function newAccountId(prefix: string): Promise<string> {
  const db = await testDb();
  const tag = suffix();
  const account = await upsertAccountByClerkUser(db, {
    clerkUserId: `${prefix}_${tag}`,
    email: `${prefix}_${tag}@example.test`,
  });
  return account.account_id;
}

function assertNoSlice4Confirm(stop: Extract<OauthStop, { kind: "interaction" }>): string {
  for (const action of stop.formActions) {
    assert.doesNotMatch(action, /\/confirm$/, `Slice 4 /confirm must not appear: ${action}`);
    assert.doesNotMatch(action, /\/deny$/, `Slice 4 /deny must not appear: ${action}`);
  }
  const allow = stop.formActions[0];
  assert.ok(allow, "expected the pre-3.5 Allow form");
  assert.match(allow, /\/login$/);
  return allow;
}

async function authorizeChatGptToCallback(
  session: ReturnType<typeof createOauthSession>,
  clientId: string,
  redirectUri = CHATGPT_REDIRECT,
): Promise<Extract<OauthStop, { kind: "callback" }>> {
  let stop = await session.authorize({
    clientId,
    redirectUri,
    scope: CHATGPT_SCOPE,
  });
  for (let hops = 0; stop.kind === "interaction" && hops < 4; hops++) {
    stop = await session.submit(assertNoSlice4Confirm(stop));
  }
  assert.equal(stop.kind, "callback", `expected OAuth callback, got ${stop.kind}`);
  assert.ok(stop.kind === "callback" && stop.code, "expected an authorization code");
  return stop as Extract<OauthStop, { kind: "callback" }>;
}

test("consent: unauthenticated authorization request is sent to sign-in", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const session = createOauthSession(port, config, null);
    const clientId = await session.register({
      client_name: "ChatGPT",
      redirect_uris: [CHATGPT_REDIRECT],
    });
    const stop = await session.authorize({
      clientId,
      redirectUri: CHATGPT_REDIRECT,
      scope: CHATGPT_SCOPE,
    });
    assert.equal(stop.kind, "signin");
  });
});

test("consent: authenticated ChatGPT-shaped authorize reaches callback without Slice 4 confirm", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const session = createOauthSession(port, config, await newAccountId("chatgpt_auto"));
    const clientId = await session.register({
      client_name: "ChatGPT",
      redirect_uris: [CHATGPT_REDIRECT],
    });
    const stop = await authorizeChatGptToCallback(session, clientId);
    const tokens = await session.exchange({ clientId, code: stop.code! });
    assert.equal(typeof tokens.access_token, "string");
    assert.equal(tokens.token_type, "Bearer");
  });
});

test("consent: a later ChatGPT-shaped client is auto-completed without a confirm screen", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const session = createOauthSession(port, config, await newAccountId("chatgpt_second"));
    const firstClient = await session.register({
      client_name: "ChatGPT",
      redirect_uris: [CHATGPT_REDIRECT],
    });
    await authorizeChatGptToCallback(session, firstClient);

    const secondRedirect = "https://chatgpt.com/connector_platform_oauth_redirect";
    const secondClient = await session.register({
      client_name: "ChatGPT-Reconnect",
      redirect_uris: [secondRedirect],
    });
    const second = await session.authorize({
      clientId: secondClient,
      redirectUri: secondRedirect,
      scope: CHATGPT_SCOPE,
    });
    assert.equal(
      second.kind,
      "callback",
      "consent for a new client must auto-complete once a ReachMy session exists",
    );
    assert.ok(second.kind === "callback" && second.code);
  });
});

test("consent: Portal Clerk bridge also reaches callback without Slice 4 confirm", async () => {
  await withServer(async (port, config) => {
    const tag = suffix();
    setClerkBrowserSessionResolverForTests(async () => ({
      clerkUserId: `chatgpt_bridge_${tag}`,
      email: `chatgpt_bridge_${tag}@example.test`,
    }));
    const session = createOauthSession(port, config, null);
    const clientId = await session.register({
      client_name: "ChatGPT",
      redirect_uris: [CHATGPT_REDIRECT],
    });
    await authorizeChatGptToCallback(session, clientId);
  });
});

test("consent: re-authorizing an already-granted client does not prompt again", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const session = createOauthSession(port, config, await newAccountId("chatgpt_repeat"));
    const clientId = await session.register({
      client_name: "ChatGPT",
      redirect_uris: [CHATGPT_REDIRECT],
    });
    const first = await authorizeChatGptToCallback(session, clientId);
    assert.ok(first.code);

    const second = await session.authorize({
      clientId,
      redirectUri: CHATGPT_REDIRECT,
      scope: CHATGPT_SCOPE,
    });
    assert.equal(second.kind, "callback", "an existing grant should not re-prompt");
    assert.ok(second.kind === "callback" && second.code, "expected a code without a new prompt");
  });
});
