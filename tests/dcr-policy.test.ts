import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRateLimiter,
  devStaticClients,
  DCR_LIMITS,
  DEV_CLI_CLIENT_ID,
  validateClientMetadata,
} from "../src/auth/dcr-policy.js";

const CLAUDE = {
  client_id: "claude",
  client_name: "Claude",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
};

const CHATGPT = {
  client_id: "chatgpt",
  client_name: "ChatGPT",
  redirect_uris: ["https://chatgpt.com/connector/oauth/abc123"],
};

test("dcr policy: the shapes Claude and ChatGPT register are accepted", () => {
  assert.equal(validateClientMetadata(CLAUDE), null);
  assert.equal(validateClientMetadata(CHATGPT), null);
});

test("dcr policy: an unfamiliar client is judged the same as a known one", () => {
  // Registration establishes identity, not authority. Nothing here may key off who is asking.
  assert.equal(
    validateClientMetadata({
      client_id: "unknown",
      client_name: "Some Other Agent",
      redirect_uris: ["https://example.test/oauth/callback"],
    }),
    null,
  );
});

test("dcr policy: http redirect URIs are rejected off loopback", () => {
  const violation = validateClientMetadata({
    client_id: "plain-http",
    redirect_uris: ["http://claude.ai/api/mcp/auth_callback"],
  });
  assert.equal(violation?.error, "invalid_redirect_uri");
});

test("dcr policy: http redirect URIs on loopback stay usable", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(
      validateClientMetadata({
        client_id: "loopback",
        redirect_uris: [`http://${host}:8123/callback`],
      }),
      null,
      `${host} should remain registrable`,
    );
  }
});

test("dcr policy: wildcard redirect URIs are rejected", () => {
  const violation = validateClientMetadata({
    client_id: "wildcard",
    redirect_uris: ["https://*.example.test/callback"],
  });
  assert.equal(violation?.error, "invalid_redirect_uri");
});

test("dcr policy: redirect URI count and client_name length are capped", () => {
  const tooMany = Array.from(
    { length: DCR_LIMITS.maxRedirectUris + 1 },
    (_, i) => `https://example.test/callback/${i}`,
  );
  assert.equal(
    validateClientMetadata({ client_id: "many", redirect_uris: tooMany })?.error,
    "invalid_redirect_uri",
  );

  assert.equal(
    validateClientMetadata({
      client_id: "long-name",
      client_name: "n".repeat(DCR_LIMITS.maxClientNameLength + 1),
      redirect_uris: ["https://example.test/callback"],
    })?.error,
    "invalid_client_metadata",
  );

  assert.equal(
    validateClientMetadata({
      client_id: "long-uri",
      redirect_uris: [`https://example.test/${"p".repeat(DCR_LIMITS.maxRedirectUriLength)}`],
    })?.error,
    "invalid_redirect_uri",
  );
});

test("dcr policy: malformed metadata is left for the provider's own schema", () => {
  assert.equal(validateClientMetadata({ client_id: "no-uris" }), null);
  assert.equal(
    validateClientMetadata({ client_id: "wrong-type", redirect_uris: "nope" as never }),
    null,
  );
});

test("dcr policy: the rate limiter permits a burst up to the limit, then refuses", () => {
  const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });
  const start = 1_000_000;
  assert.equal(limiter.allow("a", start), true);
  assert.equal(limiter.allow("a", start), true);
  assert.equal(limiter.allow("a", start), true);
  assert.equal(limiter.allow("a", start), false);

  // A second address has its own budget.
  assert.equal(limiter.allow("b", start), true);

  // And the window eventually reopens.
  assert.equal(limiter.allow("a", start + 1001), true);
});

test("dcr policy: the Phase -1 CLI client ships only outside production", () => {
  const dev = devStaticClients("http://localhost:3000", false, "openid");
  assert.equal(dev.length, 1);
  assert.equal(dev[0]?.client_id, DEV_CLI_CLIENT_ID);
  assert.deepEqual(dev[0]?.redirect_uris, ["http://localhost:3000/dev/callback"]);

  assert.deepEqual(devStaticClients("https://mcp.reachmy.ai", true, "openid"), []);
});
