import assert from "node:assert/strict";
import { test } from "node:test";
import { mintScriptToken } from "../src/auth/script-token.js";
import {
  createIdentity,
  ensureProvisionalPrincipal,
  upsertAccountByClerkUser,
} from "../src/domain/identity.js";
import { isPortalHostAllowedPath } from "../src/http/host.js";
import {
  REACHMY_MCP_CONNECTOR_URL,
  portalCopyableUrl,
  portalLayout,
  portalSetupNote,
  portalSetupSteps,
  portalStyles,
  renderPortalConnectChatGPT,
  renderPortalConnectClaude,
} from "../src/http/portal-ui.js";
import { httpRequest, seedAiConnection, sessionCookie, withServer } from "./helpers-http.js";
import { obtainOAuthAccessToken } from "./helpers-oauth-token.js";
import { makeGrantPrincipal, suffix, testDb } from "./helpers.js";

test("Slice 7: shared setup helpers and ChatGPT page reuse Portal styles", () => {
  assert.equal(REACHMY_MCP_CONNECTOR_URL, "https://mcp.reachmy.ai/mcp");
  assert.match(portalSetupSteps(["One", "Two"]), /rm-steps/);
  assert.match(
    portalCopyableUrl({ label: "URL", value: REACHMY_MCP_CONNECTOR_URL }),
    /value="https:\/\/mcp\.reachmy\.ai\/mcp"/,
  );
  assert.match(portalSetupNote("Tip"), /rm-note/);
  assert.match(portalStyles(), /\.rm-steps/);
  assert.match(portalStyles(), /\.rm-copy-row/);
  assert.match(portalLayout({ title: "T", body: "<p>x</p>", active: "home" }), /rm-shell/);

  const html = renderPortalConnectChatGPT();
  assert.match(html, /Connect ChatGPT/);
  assert.match(html, /rm-card/);
  assert.match(html, /Developer Mode/);
  assert.match(html, /ReachMy connection URL/);
  assert.match(html, /value="https:\/\/mcp\.reachmy\.ai\/mcp"/);
  assert.match(html, /Copy/);
  assert.match(html, /Enable ReachMy/);
  assert.match(html, /return here and refresh/i);
  assert.doesNotMatch(html, /grant_id|oauth_client_id|principal_id|DCR|OIDC/i);
  assert.doesNotMatch(html, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

  const claude = renderPortalConnectClaude();
  assert.match(claude, /Continue to Claude/);
  assert.match(claude, /claude\.ai\/customize\/connectors/);
});

test("Slice 7: unauthenticated /connect/chatgpt redirects to sign-in", async () => {
  await withServer(async (port, config) => {
    const res = await httpRequest(port, config.portalHost, "/connect/chatgpt");
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/sign-in?redirect=%2Fconnect%2Fchatgpt");
  });
});

test("Slice 7: authenticated user gets ChatGPT setup page", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, {
      clerkUserId: `connect_chatgpt_${tag}`,
      email: `chatgpt_${tag}@example.test`,
    });
    const res = await httpRequest(port, config.portalHost, "/connect/chatgpt", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.match(res.body, /Connect ChatGPT/);
    assert.match(res.body, /Open ChatGPT settings/);
    assert.match(res.body, /Developer Mode/);
    assert.match(res.body, /custom app or connector/i);
    assert.match(res.body, /Use the name ReachMy/);
    assert.match(res.body, /value="https:\/\/mcp\.reachmy\.ai\/mcp"/);
    assert.match(res.body, /Complete ReachMy sign-in/);
    assert.match(res.body, /Enable ReachMy in your conversation/);
    assert.match(res.body, /start a new chat/i);
    assert.match(res.body, /rm-card/);
    assert.match(res.body, /data-copy-target/);
    assert.doesNotMatch(res.body, /grant_id|oauth_client_id|agent_connection_id|principal_id/i);
  });
});

test("Slice 7: provisional / unclaimed user can access Connect ChatGPT", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `prov_chatgpt_${tag}` });
    await ensureProvisionalPrincipal(db, account.account_id);
    const res = await httpRequest(port, config.portalHost, "/connect/chatgpt", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /Connect ChatGPT/);
    assert.match(res.body, /value="https:\/\/mcp\.reachmy\.ai\/mcp"/);
  });
});

test("Slice 7: home shows Connect ChatGPT when ChatGPT is not connected", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `home_chatgpt_off_${tag}` });
    const res = await httpRequest(port, config.portalHost, "/", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /Connect ChatGPT/);
    assert.match(res.body, /href="\/connect\/chatgpt"/);
    assert.match(res.body, /Connect Claude/);
    assert.match(res.body, /href="\/connect\/claude"/);
  });
});

test("Slice 7: home shows Connected when ChatGPT is connected; Claude unchanged", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const handle = `c7_${tag}`.slice(0, 30);
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `home_chatgpt_on_${tag}` });
    const identity = await createIdentity(db, account.account_id, { handle, displayName: "C7" });
    await seedAiConnection(db, identity.principal_id!, {
      clientPayload: { client_name: "ChatGPT" },
      grantId: `grant_chatgpt_c7_${tag}`,
    });
    const res = await httpRequest(port, config.portalHost, "/", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /Connected/);
    assert.match(res.body, /Connect Claude/);
    assert.match(res.body, /href="\/connect\/claude"/);
    assert.doesNotMatch(res.body, /href="\/connect\/chatgpt"/);
  });
});

test("Slice 7: MCP/script tokens cannot authenticate /connect/chatgpt", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const { identity } = await makeGrantPrincipal(db, "oauth_connect_chatgpt", "ChatGPT");
    const oauthToken = await obtainOAuthAccessToken(port, config, identity.account_id);
    const script = mintScriptToken(identity.account_id, config.cookieKeys[0]!);

    const oauthRes = await httpRequest(port, config.portalHost, "/connect/chatgpt", {
      authorization: `Bearer ${oauthToken}`,
    });
    assert.equal(oauthRes.status, 302);
    assert.equal(oauthRes.headers.location, "/sign-in?redirect=%2Fconnect%2Fchatgpt");

    const scriptRes = await httpRequest(port, config.portalHost, "/connect/chatgpt", {
      authorization: `Bearer ${script}`,
    });
    assert.equal(scriptRes.status, 302);
    assert.equal(scriptRes.headers.location, "/sign-in?redirect=%2Fconnect%2Fchatgpt");
  });
});

test("Slice 7: /connect/chatgpt is not exposed on MCP host", async () => {
  await withServer(async (port, config) => {
    const mcpHost = new URL(config.publicUrl).hostname;
    const res = await httpRequest(port, mcpHost, "/connect/chatgpt");
    assert.notEqual(res.status, 200);
    assert.doesNotMatch(res.body, /Connect ChatGPT/);
    assert.equal(isPortalHostAllowedPath("GET", "/connect/chatgpt"), true);
  });
});

test("Slice 7: MCP/OAuth routes remain unavailable on Portal host", async () => {
  await withServer(async (port, config) => {
    assert.equal((await httpRequest(port, config.portalHost, "/mcp", { method: "POST" })).status, 404);
    assert.equal((await httpRequest(port, config.portalHost, "/auth")).status, 404);
    assert.equal((await httpRequest(port, config.portalHost, "/.well-known/oauth-authorization-server")).status, 404);
  });
});
