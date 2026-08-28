import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { encodeSessionCookie } from "../src/auth/session-cookie.js";
import { hostnameFromUrl, loadConfig } from "../src/config.js";
import { loadOrCreateJwks } from "../src/db/jwks.js";
import { createHttpServer } from "../src/server.js";
import { makePrincipal, testDb } from "./helpers.js";

type HttpResult = {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
};

function httpRequest(
  port: number,
  host: string,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: init.method ?? "GET",
        headers: { host, ...init.headers },
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

function sessionCookie(accountId: string, cookieKey: string): string {
  return `an_session=${encodeSessionCookie(accountId, cookieKey)}`;
}

function assertOnOriginLocation(location: string | string[] | undefined, publicUrl: string): void {
  const value = Array.isArray(location) ? location[0] : location;
  assert.ok(value, "expected Location header");
  assert.ok(!/^https?:\/\//i.test(value), `off-origin Location: ${value}`);
  assert.ok(!value.startsWith("//"), `protocol-relative Location: ${value}`);
  const origin = new URL(publicUrl).origin;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    assert.equal(new URL(value).origin, origin);
  }
}

test("MCP /sign-in rejects off-origin redirect for authenticated session", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const { identity } = await makePrincipal(db, "redirect_auth");
    const mcpHost = hostnameFromUrl(config.publicUrl);
    const res = await httpRequest(
      port,
      mcpHost,
      "/sign-in?redirect=https://evil.com",
      { headers: { cookie: sessionCookie(identity.account_id, config.cookieKeys[0]!) } },
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/security");
    assertOnOriginLocation(res.headers.location, config.publicUrl);
  });
});

test("MCP /sign-in sanitizes redirect embedded in sign-in page", async () => {
  await withServer(async (port, config) => {
    const mcpHost = hostnameFromUrl(config.publicUrl);
    const res = await httpRequest(port, mcpHost, "/sign-in?redirect=https://evil.com");
    assert.equal(res.status, 200);
    assert.match(res.body, /const redirectTo = "\/security"/);
    assert.doesNotMatch(res.body, /https:\/\/evil\.com/);
  });
});

test("Portal /sign-in rejects off-origin redirect for authenticated session", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const { identity } = await makePrincipal(db, "portal_redirect");
    const res = await httpRequest(
      port,
      config.portalHost,
      "/sign-in?redirect=https://evil.com",
      { headers: { cookie: sessionCookie(identity.account_id, config.cookieKeys[0]!) } },
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, "/");
    assertOnOriginLocation(res.headers.location, config.portalUrl);
  });
});
