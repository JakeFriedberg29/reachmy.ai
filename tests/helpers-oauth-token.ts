import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AppConfig } from "../src/config.js";
import { encodeSessionCookie } from "../src/auth/session-cookie.js";
import { hostnameFromUrl } from "../src/config.js";

const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const SCOPE =
  "identity:read contacts:read contacts:write interactions:read interactions:write proposals:write approvals:write offline_access";

type Cookie = { name: string; value: string; path: string };

function cookiePathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function createJar(initial?: Cookie) {
  const jar = new Map<string, Cookie>();
  if (initial) jar.set(`${initial.name}|${initial.path}`, initial);
  return {
    store(setCookie: string[] | undefined, requestPath: string) {
      for (const raw of setCookie ?? []) {
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

function httpFetch(
  port: number,
  mcpHost: string,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: { host: mcpHost, ...init.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

function mcpPath(endpoint: string, mcpHost: string): string {
  const url = new URL(endpoint, `http://${mcpHost}`);
  return `${url.pathname}${url.search}`;
}

/** Obtain a real ReachMy MCP/OAuth access token via DCR + PKCE (for security tests). */
export async function obtainOAuthAccessToken(
  port: number,
  config: AppConfig,
  accountId: string,
): Promise<string> {
  const mcpHost = hostnameFromUrl(config.publicUrl);
  const jar = createJar({
    name: "an_session",
    value: encodeSessionCookie(accountId, config.cookieKeys[0]!),
    path: "/",
  });

  const visit = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const headers = { ...init.headers };
    const cookie = jar.header(path);
    if (cookie) headers.cookie = cookie;
    const res = await httpFetch(port, mcpHost, path, { ...init, headers });
    jar.store(res.headers["set-cookie"] as string[] | undefined, path);
    return res;
  };

  const prm = JSON.parse((await visit("/.well-known/oauth-protected-resource")).body) as { resource: string };
  const asm = JSON.parse((await visit("/.well-known/oauth-authorization-server")).body) as {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
  };

  const regRes = await visit(mcpPath(asm.registration_endpoint, mcpHost), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test-Claude",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
  });
  const client = JSON.parse(regRes.body) as { client_id?: string };
  if (!client.client_id) throw new Error("DCR failed in OAuth test helper");

  const { verifier, challenge } = pkce();
  const authBase = new URL(asm.authorization_endpoint, `http://${mcpHost}`);
  authBase.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: randomBytes(8).toString("hex"),
    resource: prm.resource,
    scope: SCOPE,
  }).toString();
  let url = `${authBase.pathname}${authBase.search}`;
  let method: "GET" | "POST" = "GET";
  let code: string | null = null;
  for (let hop = 0; hop < 12; hop++) {
    const res = await visit(url, { method });
    const location = typeof res.headers.location === "string" ? res.headers.location : null;
    method = "GET";
    if (location?.startsWith(REDIRECT_URI)) {
      code = new URL(location).searchParams.get("code");
      break;
    }
    if (location) {
      const next = new URL(location, `http://${mcpHost}`);
      url = `${next.pathname}${next.search}`;
      continue;
    }
    if (res.status === 200 && url.startsWith("/interaction/")) {
      const action = res.body.match(/action="([^"]+)"/)?.[1];
      if (!action) throw new Error("OAuth consent form missing");
      url = action;
      method = "POST";
      continue;
    }
    throw new Error(`OAuth helper stopped at ${res.status} ${url}`);
  }
  if (!code) throw new Error("OAuth helper: no authorization code");

  const tokenRes = await visit(mcpPath(asm.token_endpoint, mcpHost), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: prm.resource,
    }).toString(),
  });
  const tokens = JSON.parse(tokenRes.body) as { access_token?: string };
  if (!tokens.access_token) throw new Error("OAuth helper: no access_token");
  return tokens.access_token;
}
