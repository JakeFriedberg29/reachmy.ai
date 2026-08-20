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
  upsertAccountByClerkUser,
  upsertGrantConnection,
} from "../src/domain/identity.js";
import { isPortalHostAllowedPath } from "../src/http/host.js";
import {
  REACHMY_MCP_CONNECTOR_URL,
  claudePrefillConnectorUrl,
  portalLayout,
  portalStyles,
  renderPortalConnectClaude,
} from "../src/http/portal-ui.js";
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
    assert.match(res.body, /Coming next/);
    assert.doesNotMatch(res.body, /Connect ChatGPT/);
  });
});

test("Slice 6: home shows Connected when Claude is connected; ChatGPT unchanged", async () => {
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
    assert.match(res.body, /Coming next/);
    assert.doesNotMatch(res.body, /href="\/connect\/claude"/);
    assert.doesNotMatch(res.body, /Connect ChatGPT/);
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
