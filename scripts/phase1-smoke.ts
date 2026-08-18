import { createHash, randomBytes } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { encodeSessionCookie } from "../src/auth/session-cookie.js";
import { createSql, createDb } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";
import { loadOrCreateJwks } from "../src/db/jwks.js";
import { provisionTestPrincipal } from "../src/domain/identity.js";
import { createHttpServer } from "../src/server.js";

const suffix = Date.now().toString(36).slice(-6);
const redirectUri = "https://claude.ai/api/mcp/auth_callback";
const scope = "identity:read contacts:read contacts:write interactions:read interactions:write proposals:write approvals:write offline_access";

type Cookie = { name: string; value: string; path: string };

function cookiePathMatches(cookiePath: string, requestPath: string) {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function createJar(initial?: Cookie) {
  const jar = new Map<string, Cookie>();
  if (initial) jar.set(`${initial.name}|${initial.path}`, initial);
  return {
    store(res: Response, requestPath: string) {
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair, ...attrs] = raw.split(";");
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        let path = requestPath.slice(0, requestPath.lastIndexOf("/")) || "/";
        let expired = false;
        for (const attr of attrs) {
          const [k, v = ""] = attr.split("=");
          const key = k.trim().toLowerCase();
          if (key === "path") path = v.trim();
          if (key === "max-age" && Number(v) <= 0) expired = true;
          if (key === "expires" && new Date(v).getTime() <= Date.now()) expired = true;
        }
        const id = `${name}|${path}`;
        if (expired || value === "") jar.delete(id);
        else jar.set(id, { name, value, path });
      }
    },
    header(requestPath: string) {
      return [...jar.values()]
        .filter((c) => cookiePathMatches(c.path, requestPath))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
    },
  };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function parseMcpRpc(text: string): { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown } {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = [...text.matchAll(/^data:\s*(.+)$/gm)].map((match) => match[1]);
  if (data.length) return JSON.parse(data[data.length - 1]!);
  throw new Error(`unparseable MCP: ${text.slice(0, 400)}`);
}

async function main() {
  const config = loadConfig();
  const sql = createSql(config.databaseUrl);
  const db = createDb(sql);
  await applyMigrations(db, config.databaseUrl);
  const jwks = await loadOrCreateJwks(db);
  const server = await createHttpServer(config, db, jwks);
  const listenUrl = new URL(config.publicUrl);
  const listenPort = Number(listenUrl.port || config.port);
  const listenHost = listenUrl.hostname === "localhost" ? "127.0.0.1" : listenUrl.hostname;
  await new Promise<void>((resolve) => server.listen(listenPort, listenHost, resolve));
  const base = config.publicUrl.replace(/\/$/, "");

  const mcpCall = async (token: string, id: number, name: string, args: Record<string, unknown> = {}, sessionId?: string | null) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await res.text();
    if (res.status === 401) {
      return { status: 401, sessionId: res.headers.get("mcp-session-id"), body: null as Record<string, never> | null, raw: text };
    }
    if (!res.ok) throw new Error(`MCP ${res.status} ${name}: ${text.slice(0, 400)}`);
    const rpc = parseMcpRpc(text);
    const payloadText = rpc.result?.content?.[0]?.text;
    const body = payloadText ? JSON.parse(payloadText) : null;
    if (rpc.result?.isError) throw new Error(`${name} error: ${payloadText}`);
    return { status: res.status, sessionId: res.headers.get("mcp-session-id"), body, raw: text };
  };

  async function oauthSession(accountId: string, label: string) {
    const jar = createJar({
      name: "an_session",
      value: encodeSessionCookie(accountId, config.cookieKeys[0]!),
      path: "/",
    });
    const visit = async (url: string, init: RequestInit = {}) => {
      const path = new URL(url).pathname;
      const headers = { ...(init.headers as Record<string, string> | undefined) };
      const cookie = jar.header(path);
      if (cookie) headers.cookie = cookie;
      const res = await fetch(url, { ...init, headers, redirect: "manual" });
      jar.store(res, path);
      return res;
    };

    const prm = await (await visit(`${base}/.well-known/oauth-protected-resource`)).json() as { resource: string };
    const asm = await (await visit(`${base}/.well-known/oauth-authorization-server`)).json() as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
    };
    const regRes = await visit(asm.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: label,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope,
      }),
    });
    const client = await regRes.json() as { client_id?: string };
    if (!client.client_id) throw new Error(`${label} DCR failed`);
    const { verifier, challenge } = pkce();
    const authUrl = new URL(asm.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", client.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", randomBytes(8).toString("hex"));
    authUrl.searchParams.set("resource", prm.resource);
    authUrl.searchParams.set("scope", scope);

    let url = authUrl.toString();
    let method = "GET";
    let code: string | null = null;
    for (let hop = 0; hop < 12; hop++) {
      const res = await visit(url, { method });
      const location = res.headers.get("location");
      method = "GET";
      if (location?.startsWith(redirectUri)) {
        code = new URL(location).searchParams.get("code");
        break;
      }
      if (location) {
        url = new URL(location, base).toString();
        continue;
      }
      if (res.status === 200 && new URL(url).pathname.startsWith("/interaction/")) {
        const html = await res.text();
        if (html.includes("/sign-in")) throw new Error(`${label} OAuth hit sign-in; session cookie missing`);
        const action = html.match(/action="([^"]+)"/)?.[1];
        if (!action) throw new Error(`${label} consent page had no form`);
        url = new URL(action, base).toString();
        method = "POST";
        continue;
      }
      throw new Error(`${label} OAuth stopped ${res.status} ${url}`);
    }
    if (!code) throw new Error(`${label} no authorization code`);
    const tokenRes = await visit(asm.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: prm.resource,
      }),
    });
    const tokens = await tokenRes.json() as { access_token?: string; refresh_token?: string };
    if (!tokens.access_token) throw new Error(`${label} no access token`);
    return { ...tokens, clientId: client.client_id, resource: prm.resource, tokenEndpoint: asm.token_endpoint, visit };
  }

  try {
    const jake = await provisionTestPrincipal(db, {
      clerkUserId: `phase1_jake_${suffix}`,
      handle: `jake_${suffix}`.slice(0, 30),
      displayName: "Jake",
    });
    const daniel = await provisionTestPrincipal(db, {
      clerkUserId: `phase1_dan_${suffix}`,
      handle: `dan_${suffix}`.slice(0, 30),
      displayName: "Daniel",
    });
    if (!jake.principal_id || !daniel.principal_id || !jake.agent_name || !daniel.agent_name) {
      throw new Error("principals missing Agent Name");
    }

    const jakeAuth = await oauthSession(jake.account_id, "Claude-Jake");
    const jakeAuth2 = await oauthSession(jake.account_id, "ChatGPT-Jake");
    const danAuth = await oauthSession(daniel.account_id, "Claude-Daniel");

    const init = async (token: string) => {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "phase1-smoke", version: "0" } },
        }),
      });
      if (!res.ok) throw new Error(`initialize ${res.status} ${await res.text()}`);
      return res.headers.get("mcp-session-id");
    };
    await init(jakeAuth.access_token!);
    await init(jakeAuth2.access_token!);
    await init(danAuth.access_token!);

    const me = await mcpCall(jakeAuth.access_token!, 1, "get_my_identity");
    if (me.body?.agent_name !== jake.agent_name) throw new Error(`expected ${jake.agent_name}, got ${me.body?.agent_name}`);

    const resolved = await mcpCall(jakeAuth.access_token!, 2, "resolve_identity", { agent_name: daniel.agent_name });
    if (resolved.body?.agent_name !== daniel.agent_name) throw new Error("resolve_identity failed");

    const invite = await mcpCall(jakeAuth.access_token!, 3, "create_invite");
    if (!invite.body?.token) throw new Error("invite token missing");
    await mcpCall(danAuth.access_token!, 4, "accept_invite", { token: invite.body.token });

    const created = await mcpCall(jakeAuth.access_token!, 5, "create_interaction", {
      to: daniel.agent_name,
      intent: "Find 30 minutes to talk",
    });
    if (created.body?.interaction?.status !== "PENDING") throw new Error("expected PENDING");

    const proposed = await mcpCall(danAuth.access_token!, 6, "create_proposal", {
      interaction_id: created.body.interaction.id,
      type: "TIME",
      start: "2026-08-20T15:00:00Z",
      end: "2026-08-20T15:30:00Z",
      timezone: "America/New_York",
    });
    if (proposed.body?.interaction?.status !== "AWAITING_OWNER") throw new Error("expected AWAITING_OWNER");

    const approved = await mcpCall(jakeAuth.access_token!, 7, "approve_proposal", {
      proposal_id: proposed.body.proposal.id,
    });
    if (approved.body?.interaction?.status !== "AGREED") {
      throw new Error(`expected AGREED, got ${approved.body?.interaction?.status}`);
    }

    const refreshRes = await jakeAuth.visit(jakeAuth.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: jakeAuth.refresh_token ?? "",
        client_id: jakeAuth.clientId,
        resource: jakeAuth.resource,
      }),
    });
    const refreshed = await refreshRes.json() as { access_token?: string; refresh_token?: string };
    if (!refreshed.access_token) throw new Error("refresh failed before revoke");
    const refreshedMe = await mcpCall(refreshed.access_token, 8, "get_my_identity");
    if (refreshedMe.body?.agent_name !== jake.agent_name) throw new Error("refresh identity mismatch");

    const listed = await mcpCall(jakeAuth.access_token!, 9, "list_agent_connections");
    const connectionId = me.body?.agent_connection_id ?? listed.body?.connections?.[0]?.agent_connection_id;
    if (!connectionId) throw new Error("missing agent_connection_id");

    const revoked = await mcpCall(jakeAuth.access_token!, 10, "revoke_agent_connection", {
      agent_connection_id: connectionId,
    });
    if (revoked.body?.status !== "revoked") throw new Error("expected revoked");

    const after = await mcpCall(jakeAuth.access_token!, 11, "get_my_identity");
    if (after.status !== 401) throw new Error(`revoked connection still acted: ${after.status} ${after.raw.slice(0, 200)}`);

    const other = await mcpCall(jakeAuth2.access_token!, 12, "get_my_identity");
    if (other.body?.agent_name !== jake.agent_name) throw new Error("second AI connection lost Agent Name");
    const stillDaniel = await mcpCall(danAuth.access_token!, 13, "resolve_identity", { agent_name: jake.agent_name });
    if (stillDaniel.body?.agent_name !== jake.agent_name) throw new Error("Agent Name was deleted");

    const postRevokeRefresh = await jakeAuth.visit(jakeAuth.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshed.refresh_token ?? jakeAuth.refresh_token ?? "",
        client_id: jakeAuth.clientId,
        resource: jakeAuth.resource,
      }),
    });
    if (postRevokeRefresh.ok) {
      throw new Error("revoked grant still refreshed");
    }

    const secondRefresh = await jakeAuth2.visit(jakeAuth2.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: jakeAuth2.refresh_token ?? "",
        client_id: jakeAuth2.clientId,
        resource: jakeAuth2.resource,
      }),
    });
    const secondRefreshed = await secondRefresh.json() as { access_token?: string };
    if (!secondRefreshed.access_token) throw new Error("surviving AI connection refresh failed");
    const secondMe = await mcpCall(secondRefreshed.access_token, 14, "get_my_identity");
    if (secondMe.body?.agent_name !== jake.agent_name) throw new Error("surviving connection identity mismatch");

    console.log(
      JSON.stringify({
        ok: true,
        phase: 1,
        interaction_status: approved.body.interaction.status,
        agent_names: [jake.agent_name, daniel.agent_name],
        revoked_connection: connectionId,
      }),
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
