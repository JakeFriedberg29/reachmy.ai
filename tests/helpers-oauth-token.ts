import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { encodeSessionCookie } from "../src/auth/session-cookie.js";
import { hostnameFromUrl, type AppConfig } from "../src/config.js";

export const DEFAULT_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
export const DEFAULT_SCOPE =
  "identity:read contacts:read contacts:write interactions:read interactions:write proposals:write approvals:write offline_access";

const MAX_HOPS = 12;

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
        const eq = pair!.indexOf("=");
        const name = pair!.slice(0, eq).trim();
        const value = pair!.slice(eq + 1).trim();
        let path = requestPath.slice(0, requestPath.lastIndexOf("/")) || "/";
        let expired = false;
        for (const attr of attrs) {
          const [k, v = ""] = attr.split("=");
          const key = k!.trim().toLowerCase();
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

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string };

function httpFetch(
  port: number,
  mcpHost: string,
  path: string,
  init: FetchInit = {},
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

/** Where an authorization walk came to rest. */
export type OauthStop =
  | { kind: "interaction"; url: string; status: number; body: string; formActions: string[] }
  | {
      kind: "callback";
      location: string;
      code: string | null;
      error: string | null;
      errorDescription: string | null;
    }
  | { kind: "signin"; location: string }
  | { kind: "unexpected"; url: string; status: number; body: string };

export type AuthorizeInput = {
  clientId: string;
  scope?: string;
  redirectUri?: string;
  resource?: string;
};

/**
 * Drives a browser-shaped OAuth flow against the MCP host: DCR, authorization, consent-form
 * submission, and token exchange, with one cookie jar for the whole session. Unlike
 * `obtainOAuthAccessToken` it stops at each interaction page instead of auto-approving, so
 * consent behavior itself can be asserted.
 */
export function createOauthSession(port: number, config: AppConfig, accountId: string | null) {
  const mcpHost = hostnameFromUrl(config.publicUrl);
  const jar = createJar(
    accountId
      ? { name: "an_session", value: encodeSessionCookie(accountId, config.cookieKeys[0]!), path: "/" }
      : undefined,
  );

  let metadata: {
    resource: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint: string;
  } | null = null;
  let verifier: string | null = null;
  let redirectUri = DEFAULT_REDIRECT_URI;

  const visit = async (path: string, init: FetchInit = {}) => {
    const headers = { ...init.headers };
    const cookie = jar.header(path);
    if (cookie) headers.cookie = cookie;
    const res = await httpFetch(port, mcpHost, path, { ...init, headers });
    jar.store(res.headers["set-cookie"] as string[] | undefined, path);
    return res;
  };

  const discover = async () => {
    if (metadata) return metadata;
    const prm = JSON.parse((await visit("/.well-known/oauth-protected-resource")).body) as {
      resource: string;
    };
    const asm = JSON.parse((await visit("/.well-known/oauth-authorization-server")).body) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
    };
    metadata = {
      resource: prm.resource,
      authorizationEndpoint: asm.authorization_endpoint,
      tokenEndpoint: asm.token_endpoint,
      registrationEndpoint: asm.registration_endpoint,
    };
    return metadata;
  };

  const walk = async (startUrl: string, startMethod: "GET" | "POST"): Promise<OauthStop> => {
    let url = startUrl;
    let method: "GET" | "POST" = startMethod;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const res = await visit(url, { method });
      method = "GET";
      const location = typeof res.headers.location === "string" ? res.headers.location : null;
      if (location?.startsWith(redirectUri)) {
        const cb = new URL(location);
        return {
          kind: "callback",
          location,
          code: cb.searchParams.get("code"),
          error: cb.searchParams.get("error"),
          errorDescription: cb.searchParams.get("error_description"),
        };
      }
      if (location) {
        const next = new URL(location, `http://${mcpHost}`);
        if (next.pathname === "/sign-in") return { kind: "signin", location };
        url = `${next.pathname}${next.search}`;
        continue;
      }
      if (res.status === 200 && url.startsWith("/interaction/")) {
        return {
          kind: "interaction",
          url,
          status: res.status,
          body: res.body,
          formActions: [...res.body.matchAll(/action="([^"]+)"/g)].map((m) => m[1]!),
        };
      }
      return { kind: "unexpected", url, status: res.status, body: res.body };
    }
    return { kind: "unexpected", url, status: 0, body: `exceeded ${MAX_HOPS} hops` };
  };

  return {
    discover,

    async register(overrides: Record<string, unknown> = {}): Promise<string> {
      const meta = await discover();
      const res = await visit(mcpPath(meta.registrationEndpoint, mcpHost), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Test-Claude",
          redirect_uris: [DEFAULT_REDIRECT_URI],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: DEFAULT_SCOPE,
          ...overrides,
        }),
      });
      const client = JSON.parse(res.body) as { client_id?: string };
      if (!client.client_id) throw new Error(`DCR failed: ${res.status} ${res.body.slice(0, 200)}`);
      return client.client_id;
    },

    async authorize(input: AuthorizeInput): Promise<OauthStop> {
      const meta = await discover();
      redirectUri = input.redirectUri ?? DEFAULT_REDIRECT_URI;
      const generated = pkce();
      verifier = generated.verifier;
      const authUrl = new URL(meta.authorizationEndpoint, `http://${mcpHost}`);
      authUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: input.clientId,
        redirect_uri: redirectUri,
        code_challenge: generated.challenge,
        code_challenge_method: "S256",
        state: randomBytes(8).toString("hex"),
        resource: input.resource ?? meta.resource,
        scope: input.scope ?? DEFAULT_SCOPE,
      }).toString();
      return walk(`${authUrl.pathname}${authUrl.search}`, "GET");
    },

    submit(action: string): Promise<OauthStop> {
      const next = new URL(action, `http://${mcpHost}`);
      return walk(`${next.pathname}${next.search}`, "POST");
    },

    async exchange(input: {
      clientId: string;
      code: string;
      resource?: string;
    }): Promise<Record<string, unknown>> {
      const meta = await discover();
      if (!verifier) throw new Error("exchange() called before authorize()");
      const res = await visit(mcpPath(meta.tokenEndpoint, mcpHost), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: redirectUri,
          client_id: input.clientId,
          code_verifier: verifier,
          resource: input.resource ?? meta.resource,
        }).toString(),
      });
      return JSON.parse(res.body) as Record<string, unknown>;
    },

    async refresh(input: {
      clientId: string;
      refreshToken: string;
      resource?: string;
    }): Promise<Record<string, unknown>> {
      const meta = await discover();
      const res = await visit(mcpPath(meta.tokenEndpoint, mcpHost), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: input.refreshToken,
          client_id: input.clientId,
          resource: input.resource ?? meta.resource,
        }).toString(),
      });
      return JSON.parse(res.body) as Record<string, unknown>;
    },
  };
}

/**
 * Approve every interaction and return a usable MCP access token. Used by security tests that
 * need a real token but do not care about the consent screen itself.
 */
export async function obtainOAuthAccessToken(
  port: number,
  config: AppConfig,
  accountId: string,
): Promise<string> {
  const session = createOauthSession(port, config, accountId);
  const clientId = await session.register();
  let stop = await session.authorize({ clientId });
  for (let approvals = 0; stop.kind === "interaction" && approvals < 4; approvals++) {
    const allow = stop.formActions[0];
    if (!allow) throw new Error("OAuth consent form missing");
    stop = await session.submit(allow);
  }
  if (stop.kind !== "callback") {
    throw new Error(`OAuth helper stopped at ${stop.kind}`);
  }
  if (!stop.code) throw new Error(`OAuth helper: no authorization code (${stop.error})`);
  const tokens = await session.exchange({ clientId, code: stop.code });
  if (typeof tokens.access_token !== "string") throw new Error("OAuth helper: no access_token");
  return tokens.access_token;
}
