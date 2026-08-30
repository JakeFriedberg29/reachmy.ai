/**
 * Diagnostic DCR surface: ChatGPT-shaped registration stays open, and production still hides
 * the Phase -1 CLI client and `/dev/callback`. Slice 5 metadata validation and rate limits
 * are intentionally absent on this branch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setClerkBrowserSessionResolverForTests } from "../src/auth/browser-account.js";
import { DEV_CLI_CLIENT_ID } from "../src/auth/dcr-policy.js";
import { hostnameFromUrl, type AppConfig } from "../src/config.js";
import { httpRequest, withServer, type HttpResult } from "./helpers-http.js";
import { suffix } from "./helpers.js";

const BASE_METADATA = {
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

function register(
  port: number,
  config: AppConfig,
  metadata: Record<string, unknown>,
): Promise<HttpResult> {
  return httpRequest(port, hostnameFromUrl(config.publicUrl), "/reg", {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({ ...BASE_METADATA, ...metadata }),
  });
}

function body(result: HttpResult): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>;
}

async function withProductionServer(
  run: (port: number, config: AppConfig) => Promise<void>,
): Promise<void> {
  const original = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = "https://mcp.slice5.test";
  try {
    await withServer(run);
  } finally {
    if (original === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = original;
  }
}

test("dcr: ChatGPT-shaped registration succeeds", async () => {
  await withServer(async (port, config) => {
    const result = await register(port, config, {
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    });
    assert.equal(result.status, 201, result.body);
    const client = body(result);
    assert.equal(typeof client.client_id, "string");
    assert.deepEqual(client.redirect_uris, ["https://chatgpt.com/connector_platform_oauth_redirect"]);
  });
});

test("dcr: registration stays open to clients we have never seen", async () => {
  await withServer(async (port, config) => {
    const result = await register(port, config, {
      client_name: `Unknown-Agent-${suffix()}`,
      redirect_uris: ["https://agent.example.test/oauth/callback"],
    });
    assert.equal(result.status, 201, result.body);
  });
});

test("dcr: production ships without /dev/callback or the Phase -1 CLI client", async () => {
  await withProductionServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const host = hostnameFromUrl(config.publicUrl);

    const devCallback = await httpRequest(port, host, "/dev/callback?code=abc");
    assert.equal(devCallback.status, 404);

    const authorize = await httpRequest(
      port,
      host,
      `/auth?${new URLSearchParams({
        response_type: "code",
        client_id: DEV_CLI_CLIENT_ID,
        redirect_uri: `${config.publicUrl}/dev/callback`,
        scope: "openid",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
      })}`,
    );
    assert.match(authorize.body, /invalid_client/);
  });
});

test("dcr: local development keeps /dev/callback and the Phase -1 CLI client", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const host = hostnameFromUrl(config.publicUrl);

    const devCallback = await httpRequest(port, host, "/dev/callback?code=abc");
    assert.equal(devCallback.status, 200);

    const authorize = await httpRequest(
      port,
      host,
      `/auth?${new URLSearchParams({
        response_type: "code",
        client_id: DEV_CLI_CLIENT_ID,
        redirect_uri: `${config.publicUrl}/dev/callback`,
        scope: "openid",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
      })}`,
    );
    assert.doesNotMatch(authorize.body, /invalid_client/);
  });
});
