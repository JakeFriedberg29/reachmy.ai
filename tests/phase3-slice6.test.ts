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
  claudePrefillConnectorUrl,
  portalLayout,
  portalStyles,
  renderPortalConnectClaude,
} from "../src/http/portal-ui.js";
import { httpRequest, seedAiConnection, sessionCookie, withServer } from "./helpers-http.js";
import { obtainOAuthAccessToken } from "./helpers-oauth-token.js";
import { makeGrantPrincipal, suffix, testDb } from "./helpers.js";

function extractContinueHref(html: string): string {
  const match = html.match(/href="(https:\/\/claude\.ai\/customize\/connectors[^"]*)"/);
  assert.ok(match?.[1], "expected Continue to Claude href");
  return match[1]!.replaceAll("&amp;", "&");
}

test("Slice 6: Claude prefilled connector URL is canonical and has no account identifiers", () => {
  assert.equal(REACHMY_MCP_CONNECTOR_URL, "https://mcp.reachmy.ai/mcp");
  const url = claudePrefillConnectorUrl();
  assert.equal(
    url,
    "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=ReachMy&connectorUrl=https%3A%2F%2Fmcp.reachmy.ai%2Fmcp",
  );
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://claude.ai");
  assert.equal(parsed.pathname, "/customize/connectors");
  assert.equal(parsed.searchParams.get("modal"), "add-custom-connector");
  assert.equal(parsed.searchParams.get("connectorName"), "ReachMy");
  assert.equal(parsed.searchParams.get("connectorUrl"), "https://mcp.reachmy.ai/mcp");
  assert.doesNotMatch(url, /account|principal|grant|uuid|clerk/i);
  assert.doesNotMatch(url, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test("Slice 6: Connect Claude page reuses Portal layout and styles", () => {
  const html = renderPortalConnectClaude();
  assert.match(html, /Connect Claude/);
  assert.match(html, /Continue to Claude/);
  assert.match(html, /rm-card/);
  assert.match(html, /rm-btn--primary/);
  assert.match(html, /ReachMy/);
  assert.match(portalLayout({ title: "T", body: "<p>x</p>", active: "home" }), /rm-shell/);
  assert.match(portalStyles(), /\.rm-btn--primary/);
  const href = extractContinueHref(html);
  assert.equal(href, claudePrefillConnectorUrl());
  assert.equal(new URL(href).searchParams.get("connectorUrl"), REACHMY_MCP_CONNECTOR_URL);
});

test("Slice 6: unauthenticated /connect/claude redirects to sign-in", async () => {
  await withServer(async (port, config) => {
    const res = await httpRequest(port, config.portalHost, "/connect/claude");
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/sign-in?redirect=%2Fconnect%2Fclaude");
  });
});

test("Slice 6: authenticated user gets Connect Claude setup page", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, {
      clerkUserId: `connect_claude_${tag}`,
      email: `claude_${tag}@example.test`,
    });
    const res = await httpRequest(port, config.portalHost, "/connect/claude", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.match(res.body, /Connect Claude/);
    assert.match(res.body, /Continue to Claude/);
    assert.match(res.body, /rm-card/);
    assert.match(res.body, /return here and refresh/i);
    const href = extractContinueHref(res.body);
    assert.equal(href, claudePrefillConnectorUrl());
    assert.equal(new URL(href).searchParams.get("connectorUrl"), "https://mcp.reachmy.ai/mcp");
    assert.doesNotMatch(res.body, /grant_id|oauth_client_id|agent_connection_id|principal_id/i);
    assert.doesNotMatch(href, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
});

test("Slice 6: provisional / unclaimed user can access Connect Claude", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `prov_connect_${tag}` });
    await ensureProvisionalPrincipal(db, account.account_id);
    const res = await httpRequest(port, config.portalHost, "/connect/claude", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /Continue to Claude/);
  });
});

test("Slice 6: home shows Connect Claude when Claude is not connected", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `home_claude_off_${tag}` });
    const res = await httpRequest(port, config.portalHost, "/", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /Connect Claude/);
    assert.match(res.body, /href="\/connect\/claude"/);
    assert.match(res.body, /Connect ChatGPT/);
    assert.match(res.body, /href="\/connect\/chatgpt"/);
  });
});

test("Slice 6: home shows Connected when Claude is connected; ChatGPT connect still available", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const tag = suffix();
    const handle = `c6_${tag}`.slice(0, 30);
    const account = await upsertAccountByClerkUser(db, { clerkUserId: `home_claude_on_${tag}` });
    const identity = await createIdentity(db, account.account_id, { handle, displayName: "C6" });
    await seedAiConnection(db, identity.principal_id!, {
      clientPayload: { client_name: "Claude" },
      grantId: `grant_claude_c6_${tag}`,
    });
    const res = await httpRequest(port, config.portalHost, "/", {
      cookie: sessionCookie(account.account_id, config.cookieKeys[0]!),
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /Connected/);
    assert.match(res.body, /Connect ChatGPT/);
    assert.doesNotMatch(res.body, /href="\/connect\/claude"/);
  });
});

test("Slice 6: MCP/script tokens cannot authenticate /connect/claude", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const { identity } = await makeGrantPrincipal(db, "oauth_connect_claude", "Claude");
    const oauthToken = await obtainOAuthAccessToken(port, config, identity.account_id);
    const script = mintScriptToken(identity.account_id, config.cookieKeys[0]!);

    const oauthRes = await httpRequest(port, config.portalHost, "/connect/claude", {
      authorization: `Bearer ${oauthToken}`,
    });
    assert.equal(oauthRes.status, 302);
    assert.equal(oauthRes.headers.location, "/sign-in?redirect=%2Fconnect%2Fclaude");

    const scriptRes = await httpRequest(port, config.portalHost, "/connect/claude", {
      authorization: `Bearer ${script}`,
    });
    assert.equal(scriptRes.status, 302);
    assert.equal(scriptRes.headers.location, "/sign-in?redirect=%2Fconnect%2Fclaude");
  });
});

test("Slice 6: /connect/claude is not exposed on MCP host", async () => {
  await withServer(async (port, config) => {
    const mcpHost = new URL(config.publicUrl).hostname;
    const res = await httpRequest(port, mcpHost, "/connect/claude");
    assert.notEqual(res.status, 200);
    assert.doesNotMatch(res.body, /Continue to Claude/);
    assert.equal(isPortalHostAllowedPath("GET", "/connect/claude"), true);
  });
});

test("Slice 6: MCP/OAuth routes remain unavailable on Portal host", async () => {
  await withServer(async (port, config) => {
    assert.equal((await httpRequest(port, config.portalHost, "/mcp", { method: "POST" })).status, 404);
    assert.equal((await httpRequest(port, config.portalHost, "/auth")).status, 404);
    assert.equal((await httpRequest(port, config.portalHost, "/.well-known/oauth-authorization-server")).status, 404);
  });
});
