import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { hostnameFromUrl, loadConfig } from "../src/config.js";
import { loadOrCreateJwks } from "../src/db/jwks.js";
import { createHttpServer } from "../src/server.js";
import { testDb } from "./helpers.js";

type HttpResult = {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
};

function httpRequest(port: number, host: string, path: string, method = "GET"): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { host },
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

test("Slice 0: portal host serves health and blocks MCP/OAuth paths", async () => {
  await withServer(async (port, config) => {
    const health = await httpRequest(port, config.portalHost, "/health");
    assert.equal(health.status, 200);
    const healthJson = JSON.parse(health.body) as { surface: string; portal_url: string };
    assert.equal(healthJson.surface, "portal");
    assert.equal(healthJson.portal_url, config.portalUrl);

    const root = await httpRequest(port, config.portalHost, "/");
    assert.equal(root.status, 302);
    assert.equal(root.headers.location, "/sign-in");

    const signIn = await httpRequest(port, config.portalHost, "/sign-in");
    assert.equal(signIn.status, 200);
    assert.match(signIn.body, /Sign in/);
    assert.match(signIn.body, /ReachMy/);

    const mcp = await httpRequest(port, config.portalHost, "/mcp", "POST");
    assert.equal(mcp.status, 404);

    const wellKnown = await httpRequest(port, config.portalHost, "/.well-known/oauth-authorization-server");
    assert.equal(wellKnown.status, 404);

    const auth = await httpRequest(port, config.portalHost, "/auth");
    assert.equal(auth.status, 404);
  });
});

test("Slice 0: MCP host preserves existing health and MCP route availability", async () => {
  await withServer(async (port, config) => {
    const mcpHost = hostnameFromUrl(config.publicUrl);
    const health = await httpRequest(port, mcpHost, "/health");
    assert.equal(health.status, 200);
    const healthJson = JSON.parse(health.body) as { surface: string; issuer: string; mcp: string };
    assert.equal(healthJson.surface, "mcp");
    assert.equal(healthJson.issuer, config.publicUrl);
    assert.equal(healthJson.mcp, "/mcp");

    const mcp = await httpRequest(port, mcpHost, "/mcp", "POST");
    assert.equal(mcp.status, 401);
    const mcpJson = JSON.parse(mcp.body) as { error: string };
    assert.equal(mcpJson.error, "invalid_token");
  });
});

test("Slice 0: unknown host is rejected fail-closed", async () => {
  await withServer(async (port) => {
    const res = await httpRequest(port, "evil.example", "/health");
    assert.equal(res.status, 421);
    const json = JSON.parse(res.body) as { error: string };
    assert.equal(json.error, "invalid_host");
  });
});
