import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/config.js";
import {
  classifyRequestHost,
  isMcpBackendPath,
  isPortalHostAllowedPath,
  mcpHostnames,
  normalizeHostname,
} from "../src/http/host.js";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3000,
    publicUrl: "https://mcp.reachmy.ai",
    portalUrl: "https://app.reachmy.ai",
    portalHost: "app.reachmy.ai",
    cookieKeys: ["test-cookie-key"],
    allowedHosts: ["mcp.reachmy.ai", "app.reachmy.ai", "localhost", "127.0.0.1"],
    databaseUrl: "postgresql://example",
    clerkPublishableKey: "pk_test",
    clerkSecretKey: "sk_test",
    ...overrides,
  };
}

test("normalizeHostname strips port and lowercases", () => {
  assert.equal(normalizeHostname("App.ReachMy.AI:443"), "app.reachmy.ai");
  assert.equal(normalizeHostname("localhost:3000"), "localhost");
  assert.equal(normalizeHostname("[::1]:3000"), "::1");
});

test("classifyRequestHost distinguishes portal, mcp, and unknown", () => {
  const config = testConfig();
  assert.equal(classifyRequestHost("app.reachmy.ai", config), "portal");
  assert.equal(classifyRequestHost("mcp.reachmy.ai", config), "mcp");
  assert.equal(classifyRequestHost("localhost", config), "mcp");
  assert.equal(classifyRequestHost("evil.example", config), "unknown");
});

test("portal host takes precedence when explicitly configured", () => {
  const config = testConfig({
    portalHost: "app.reachmy.ai",
    publicUrl: "https://app.reachmy.ai",
    allowedHosts: ["app.reachmy.ai", "localhost"],
  });
  assert.equal(classifyRequestHost("app.reachmy.ai", config), "portal");
});

test("mcpHostnames excludes portal host", () => {
  const config = testConfig();
  const hosts = mcpHostnames(config);
  assert.ok(hosts.has("mcp.reachmy.ai"));
  assert.ok(hosts.has("localhost"));
  assert.equal(hosts.has("app.reachmy.ai"), false);
});

test("isMcpBackendPath blocks MCP/OAuth/API surfaces", () => {
  assert.equal(isMcpBackendPath("/mcp"), true);
  assert.equal(isMcpBackendPath("/auth"), true);
  assert.equal(isMcpBackendPath("/token"), true);
  assert.equal(isMcpBackendPath("/reg"), true);
  assert.equal(isMcpBackendPath("/interaction/abc"), true);
  assert.equal(isMcpBackendPath("/.well-known/oauth-authorization-server"), true);
  assert.equal(isMcpBackendPath("/v1/me"), true);
  assert.equal(isMcpBackendPath("/sign-in"), true);
  assert.equal(isMcpBackendPath("/health"), false);
  assert.equal(isMcpBackendPath("/"), false);
});

test("isPortalHostAllowedPath allows Portal pages, overview, and Clerk auth", () => {
  assert.equal(isPortalHostAllowedPath("GET", "/health"), true);
  assert.equal(isPortalHostAllowedPath("GET", "/"), true);
  assert.equal(isPortalHostAllowedPath("GET", "/admin"), true);
  assert.equal(isPortalHostAllowedPath("GET", "/sign-in"), true);
  assert.equal(isPortalHostAllowedPath("GET", "/account"), true);
  assert.equal(isPortalHostAllowedPath("GET", "/connect/claude"), true);
  assert.equal(isPortalHostAllowedPath("GET", "/v1/portal/overview"), true);
  assert.equal(isPortalHostAllowedPath("POST", "/v1/auth/clerk"), true);
  assert.equal(isPortalHostAllowedPath("POST", "/sign-out"), true);
  assert.equal(isPortalHostAllowedPath("POST", "/health"), false);
  assert.equal(isPortalHostAllowedPath("GET", "/connect/chatgpt"), false);
  assert.equal(isPortalHostAllowedPath("POST", "/v1/me"), false);
});
