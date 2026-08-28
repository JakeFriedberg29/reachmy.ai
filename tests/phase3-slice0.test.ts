import assert from "node:assert/strict";
import { test } from "node:test";
import { hostnameFromUrl } from "../src/config.js";
import { httpRequest, withServer } from "./helpers-http.js";

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

    const mcp = await httpRequest(port, config.portalHost, "/mcp", { method: "POST" });
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

    const mcp = await httpRequest(port, mcpHost, "/mcp", { method: "POST" });
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
