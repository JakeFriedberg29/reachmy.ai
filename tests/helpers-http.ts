import http from "node:http";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { setClerkBrowserSessionResolverForTests } from "../src/auth/browser-account.js";
import { encodeSessionCookie, SESSION_COOKIE } from "../src/auth/session-cookie.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { Database } from "../src/db/client.js";
import { loadOrCreateJwks } from "../src/db/jwks.js";
import { agentConnections, oauthModels } from "../src/db/schema.js";
import { upsertGrantConnection } from "../src/domain/identity.js";
import { createHttpServer } from "../src/server.js";
import { testDb } from "./helpers.js";

export type HttpResult = {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
};

export type HttpRequestOptions = {
  method?: string;
  cookie?: string;
  authorization?: string;
  contentType?: string;
  origin?: string;
  csrf?: string;
  body?: string;
  /** Escape hatch for headers without a dedicated option. Applied last, so it wins. */
  headers?: Record<string, string>;
};

export function httpRequest(
  port: number,
  host: string,
  path: string,
  options: HttpRequestOptions = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host };
    if (options.cookie) headers.cookie = options.cookie;
    if (options.authorization) headers.authorization = options.authorization;
    if (options.contentType) headers["content-type"] = options.contentType;
    if (options.origin) headers.origin = options.origin;
    if (options.csrf) headers["x-csrf-token"] = options.csrf;
    if (options.body) headers["content-length"] = String(Buffer.byteLength(options.body));
    Object.assign(headers, options.headers);
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

export async function withServer(
  run: (port: number, config: AppConfig) => Promise<void>,
): Promise<void> {
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
    setClerkBrowserSessionResolverForTests(null);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

/** Test files run concurrently, so the shared port has to be waited for, not just claimed. */
const PUBLIC_URL_PORT_WAIT_MS = 60_000;

function listenExclusive(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve(true);
    });
  });
}

/**
 * Same as `withServer`, but bound to the port in `PUBLIC_URL` instead of an ephemeral one.
 *
 * MCP bearer verification fetches `${PUBLIC_URL}/jwks` over HTTP, so a token can only be verified
 * when the running server is reachable at that URL. Tests that verify a real access token need
 * this; everything else should keep using `withServer`.
 */
export async function withServerOnPublicUrlPort(
  run: (port: number, config: AppConfig) => Promise<void>,
): Promise<void> {
  const config = loadConfig();
  const url = new URL(config.publicUrl);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const db = await testDb();
  const jwks = await loadOrCreateJwks(db);
  const server = await createHttpServer(config, db, jwks);
  const deadline = Date.now() + PUBLIC_URL_PORT_WAIT_MS;
  while (!(await listenExclusive(server, port))) {
    if (Date.now() > deadline) {
      throw new Error(
        `Port ${port} (from PUBLIC_URL=${config.publicUrl}) stayed in use. Stop \`pnpm dev\` and re-run.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    await run(port, config);
  } finally {
    setClerkBrowserSessionResolverForTests(null);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

export function sessionCookie(accountId: string, cookieKey: string): string {
  return `${SESSION_COOKIE}=${encodeSessionCookie(accountId, cookieKey)}`;
}

export type OauthClientPayload = { client_name?: string; redirect_uris?: string[] };

export async function seedOauthClient(
  db: Database,
  clientId: string,
  payload: OauthClientPayload,
): Promise<void> {
  await db.insert(oauthModels).values({
    model: "Client",
    id: clientId,
    payload,
  });
}

export async function seedAiConnection(
  db: Database,
  principalId: string,
  input: {
    clientPayload: OauthClientPayload;
    grantId: string;
    status?: string;
    label?: string;
  },
): Promise<string> {
  const clientId = input.grantId;
  await seedOauthClient(db, clientId, input.clientPayload);
  const connectionId = await upsertGrantConnection(db, {
    principalId,
    grantId: input.grantId,
    oauthClientId: clientId,
    displayLabel: input.label ?? "MCP",
  });
  if (input.status && input.status !== "connected") {
    await db
      .update(agentConnections)
      .set({ status: input.status })
      .where(eq(agentConnections.id, connectionId));
  }
  return connectionId;
}
