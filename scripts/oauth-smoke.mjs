// End-to-end Phase -1 OAuth + MCP smoke test.
// Mimics a Claude-style client: dynamic client registration, PKCE, resource indicator,
// browser-like redirect following with a path-aware cookie jar.
//
// Usage: node scripts/oauth-smoke.mjs [baseUrl]
//   SCOPE="identity:read interactions:write offline_access"  ("-" to omit the scope param)
//   REDIRECT_URI=https://claude.ai/api/mcp/auth_callback

import { createHash, randomBytes } from "node:crypto";

const base = (process.argv[2] ?? process.env.BASE ?? "http://localhost:8080").replace(/\/$/, "");
const redirectUri = process.env.REDIRECT_URI ?? "https://claude.ai/api/mcp/auth_callback";
const scopeArg = process.env.SCOPE ?? "identity:read interactions:write offline_access";
const scope = scopeArg === "-" ? null : scopeArg;

const jar = new Map();

function cookiePathMatches(cookiePath, requestPath) {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function storeCookies(res, requestPath) {
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
}

function cookieHeader(requestPath) {
  const sending = [...jar.values()].filter((c) => cookiePathMatches(c.path, requestPath));
  return sending.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function visit(url, init = {}) {
  const path = new URL(url).pathname;
  const headers = { ...(init.headers ?? {}) };
  const cookie = cookieHeader(path);
  if (cookie) headers.cookie = cookie;
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  storeCookies(res, path);
  return res;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const log = (step, data) => console.log(`\n### ${step}\n${JSON.stringify(data, null, 2)}`);

async function main() {
  const prm = await (await visit(`${base}/.well-known/oauth-protected-resource`)).json();
  log("protected resource metadata", prm);
  const asm = await (await visit(`${base}/.well-known/oauth-authorization-server`)).json();
  log("authorization server metadata", { issuer: asm.issuer, scopes_supported: asm.scopes_supported });

  const regRes = await visit(asm.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scope ? { scope } : {}),
    }),
  });
  const client = await regRes.json();
  log("dynamic client registration", {
    status: regRes.status,
    client_id: client.client_id,
    redirect_uris: client.redirect_uris,
    scope: client.scope,
    error: client.error,
    error_description: client.error_description,
  });
  if (!client.client_id) throw new Error("DCR failed");

  const { verifier, challenge } = pkce();
  const authUrl = new URL(asm.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", randomBytes(8).toString("hex"));
  authUrl.searchParams.set("resource", prm.resource);
  if (scope) authUrl.searchParams.set("scope", scope);

  let url = authUrl.toString();
  let method = "GET";
  let code = null;
  const trail = [];
  const interactionVisits = new Map();

  for (let hop = 0; hop < 12; hop++) {
    const res = await visit(url, { method });
    const location = res.headers.get("location");
    trail.push({ hop, method, url: url.replace(base, ""), status: res.status, location });
    method = "GET";

    if (location?.startsWith(redirectUri)) {
      const cb = new URL(location);
      code = cb.searchParams.get("code");
      log("redirected back to client", {
        location,
        code: code ? `${code.slice(0, 8)}…` : null,
        error: cb.searchParams.get("error"),
        error_description: cb.searchParams.get("error_description"),
      });
      break;
    }

    if (location) {
      url = new URL(location, base).toString();
      const path = new URL(url).pathname;
      if (path.startsWith("/interaction/")) {
        const count = (interactionVisits.get(path) ?? 0) + 1;
        interactionVisits.set(path, count);
        if (interactionVisits.size > 3) {
          log("CONSENT LOOP DETECTED", { visited: [...interactionVisits.keys()] });
          break;
        }
      }
      continue;
    }

    if (res.status === 200 && new URL(url).pathname.startsWith("/interaction/")) {
      const html = await res.text();
      const action = html.match(/action="([^"]+)"/)?.[1];
      if (!action) {
        log("interaction page had no form", { url, body: html.slice(0, 400) });
        break;
      }
      url = new URL(action, base).toString();
      method = "POST";
      continue;
    }

    log("unexpected stop", { url, status: res.status, body: (await res.text()).slice(0, 400) });
    break;
  }

  log("redirect trail", trail);
  if (!code) throw new Error("no authorization code issued");

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: prm.resource,
  });
  const tokenRes = await visit(asm.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });
  const tokens = await tokenRes.json();
  log("token response", {
    status: tokenRes.status,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    scope: tokens.scope,
    has_refresh_token: Boolean(tokens.refresh_token),
    error: tokens.error,
    error_description: tokens.error_description,
  });
  if (!tokens.access_token) throw new Error("no access token");

  const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString());
  log("access token claims", claims);

  const mcp = async (body, token) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, sessionId: res.headers.get("mcp-session-id"), text: text.slice(0, 600) };
  };

  log(
    "mcp initialize",
    await mcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "smoke", version: "0" },
        },
      },
      tokens.access_token,
    ),
  );

  log(
    "mcp tools/call get_identity",
    await mcp(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_identity", arguments: {} } },
      tokens.access_token,
    ),
  );

  const refreshRes = await visit(asm.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
      client_id: client.client_id,
      resource: prm.resource,
    }),
  });
  const refreshed = await refreshRes.json();
  log("refresh token exchange", {
    status: refreshRes.status,
    has_access_token: Boolean(refreshed.access_token),
    rotated_refresh_token: Boolean(refreshed.refresh_token),
    error: refreshed.error,
    error_description: refreshed.error_description,
  });

  if (refreshed.access_token) {
    log(
      "mcp get_identity with refreshed token",
      await mcp(
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_identity", arguments: {} } },
        refreshed.access_token,
      ),
    );
  }
}

main().catch((error) => {
  console.error(`\nSMOKE FAILED: ${error.message}`);
  process.exit(1);
});
