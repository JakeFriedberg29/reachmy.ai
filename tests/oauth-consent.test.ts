import assert from "node:assert/strict";
import { test } from "node:test";
import { setClerkBrowserSessionResolverForTests } from "../src/auth/browser-account.js";
import { upsertAccountByClerkUser } from "../src/domain/identity.js";
import { withServer } from "./helpers-http.js";
import { createOauthSession, type OauthStop } from "./helpers-oauth-token.js";
import { suffix, testDb } from "./helpers.js";

async function newAccountId(prefix: string): Promise<string> {
  const db = await testDb();
  const tag = suffix();
  const account = await upsertAccountByClerkUser(db, {
    clerkUserId: `${prefix}_${tag}`,
    email: `${prefix}_${tag}@example.test`,
  });
  return account.account_id;
}

function assertInteraction(stop: OauthStop): Extract<OauthStop, { kind: "interaction" }> {
  assert.equal(stop.kind, "interaction", `expected a consent screen, got ${stop.kind}`);
  return stop as Extract<OauthStop, { kind: "interaction" }>;
}

function allowAction(stop: Extract<OauthStop, { kind: "interaction" }>): string {
  const action = stop.formActions[0];
  assert.ok(action, "expected an Allow form");
  assert.match(action, /\/confirm$/);
  return action;
}

function denyAction(stop: Extract<OauthStop, { kind: "interaction" }>): string {
  const action = stop.formActions.find((value) => value.endsWith("/deny"));
  assert.ok(action, "expected a Deny form");
  return action;
}

test("consent: unauthenticated authorization request is sent to sign-in", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const session = createOauthSession(port, config, null);
    const clientId = await session.register();
    const stop = await session.authorize({ clientId });
    assert.equal(stop.kind, "signin");
  });
});

test("consent: authenticated user reaches consent without signing in again", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const session = createOauthSession(port, config, await newAccountId("consent_auth"));
    const clientId = await session.register();
    const stop = await session.authorize({ clientId });
    assertInteraction(stop);
  });
});

test("consent: Portal Clerk bridge still reaches consent without an an_session cookie", async () => {
  await withServer(async (port, config) => {
    const tag = suffix();
    setClerkBrowserSessionResolverForTests(async () => ({
      clerkUserId: `consent_bridge_${tag}`,
      email: `consent_bridge_${tag}@example.test`,
    }));
    const session = createOauthSession(port, config, null);
    const clientId = await session.register();
    const stop = await session.authorize({ clientId });
    assertInteraction(stop);
  });
});

test("consent: screen names the client, its redirect host, and the requested access", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const session = createOauthSession(port, config, await newAccountId("consent_screen"));
    const clientId = await session.register({ client_name: "Consent-Screen-AI" });
    const stop = assertInteraction(await session.authorize({ clientId }));

    assert.match(stop.body, /Authorize an agent/);
    assert.match(stop.body, /Consent-Screen-AI/);
    assert.match(stop.body, /claude\.ai/);
    assert.match(stop.body, /identity:read/);
    assert.match(stop.body, /interactions:write/);
    allowAction(stop);
    denyAction(stop);
  });
});

test("consent: approving completes the flow and yields a usable access token", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const session = createOauthSession(port, config, await newAccountId("consent_allow"));
    const clientId = await session.register();
    const consent = assertInteraction(await session.authorize({ clientId }));

    const stop = await session.submit(allowAction(consent));
    assert.equal(stop.kind, "callback");
    assert.ok(stop.kind === "callback" && stop.code, "expected an authorization code");

    const tokens = await session.exchange({
      clientId,
      code: (stop as Extract<OauthStop, { kind: "callback" }>).code!,
    });
    assert.equal(typeof tokens.access_token, "string");
    assert.equal(tokens.token_type, "Bearer");
  });
});

test("consent: an existing session does not silently authorize a different client", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const session = createOauthSession(port, config, await newAccountId("consent_second"));

    const firstClient = await session.register({ client_name: "First-AI" });
    const firstConsent = assertInteraction(await session.authorize({ clientId: firstClient }));
    const firstDone = await session.submit(allowAction(firstConsent));
    assert.equal(firstDone.kind, "callback");

    // Same browser, same provider session, brand new client. Authorizing the first client must
    // not carry over to the second one.
    const secondClient = await session.register({ client_name: "Second-AI" });
    const secondStop = await session.authorize({ clientId: secondClient });
    const secondConsent = assertInteraction(secondStop);
    assert.match(secondConsent.body, /Second-AI/);
    assert.doesNotMatch(secondConsent.body, /First-AI/);
  });
});

test("consent: re-authorizing an already-granted client does not prompt again", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const session = createOauthSession(port, config, await newAccountId("consent_repeat"));
    const clientId = await session.register();

    const consent = assertInteraction(await session.authorize({ clientId }));
    const first = await session.submit(allowAction(consent));
    assert.equal(first.kind, "callback");

    const second = await session.authorize({ clientId });
    assert.equal(second.kind, "callback", "an existing grant should not re-prompt");
    assert.ok(second.kind === "callback" && second.code, "expected a code without a new prompt");
  });
});

test("consent: denying issues no authorization code", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const session = createOauthSession(port, config, await newAccountId("consent_deny"));
    const clientId = await session.register();
    const consent = assertInteraction(await session.authorize({ clientId }));

    const stop = await session.submit(denyAction(consent));
    assert.equal(stop.kind, "callback");
    assert.ok(stop.kind === "callback");
    assert.equal(stop.code, null);
    assert.equal(stop.error, "access_denied");
  });
});

test("consent: a denied client must ask again and is not treated as granted", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const session = createOauthSession(port, config, await newAccountId("consent_deny_retry"));
    const clientId = await session.register();

    const first = assertInteraction(await session.authorize({ clientId }));
    const denied = await session.submit(denyAction(first));
    assert.equal(denied.kind, "callback");
    assert.ok(denied.kind === "callback" && denied.code === null);

    assertInteraction(await session.authorize({ clientId }));
  });
});
