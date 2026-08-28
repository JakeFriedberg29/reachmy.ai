import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { setClerkBrowserSessionResolverForTests } from "../src/auth/browser-account.js";
import { purgeUnauthorizedClients } from "../src/auth/drizzle-adapter.js";
import { DCR_LIMITS, DCR_RATE_LIMIT, DEV_CLI_CLIENT_ID } from "../src/auth/dcr-policy.js";
import { hostnameFromUrl, type AppConfig } from "../src/config.js";
import { oauthModels } from "../src/db/schema.js";
import { httpRequest, withServer, type HttpResult } from "./helpers-http.js";
import { suffix, testDb } from "./helpers.js";

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

/** Runs `run` against a server built from a production-shaped PUBLIC_URL. */
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

test("dcr: Claude-shaped registration succeeds", async () => {
  await withServer(async (port, config) => {
    const result = await register(port, config, {
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    assert.equal(result.status, 201, result.body);
    const client = body(result);
    assert.equal(typeof client.client_id, "string");
    assert.deepEqual(client.redirect_uris, ["https://claude.ai/api/mcp/auth_callback"]);
  });
});

test("dcr: ChatGPT-shaped registration succeeds", async () => {
  await withServer(async (port, config) => {
    const result = await register(port, config, {
      client_name: "ChatGPT",
      redirect_uris: [`https://chatgpt.com/connector/oauth/${suffix()}`],
    });
    assert.equal(result.status, 201, result.body);
    assert.equal(typeof body(result).client_id, "string");
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

test("dcr: an http redirect URI on a public host is rejected", async () => {
  await withServer(async (port, config) => {
    const result = await register(port, config, {
      client_name: "Insecure",
      redirect_uris: ["http://claude.ai/api/mcp/auth_callback"],
    });
    assert.equal(result.status, 400);
    assert.equal(body(result).error, "invalid_redirect_uri");
  });
});

test("dcr: an http redirect URI on loopback is still accepted", async () => {
  await withServer(async (port, config) => {
    const result = await register(port, config, {
      client_name: "Local-CLI",
      redirect_uris: ["http://127.0.0.1:8123/callback"],
    });
    assert.equal(result.status, 201, result.body);
  });
});

test("dcr: excessive redirect URIs are rejected", async () => {
  await withServer(async (port, config) => {
    const result = await register(port, config, {
      client_name: "Too-Many",
      redirect_uris: Array.from(
        { length: DCR_LIMITS.maxRedirectUris + 1 },
        (_, i) => `https://agent.example.test/callback/${i}`,
      ),
    });
    assert.equal(result.status, 400);
    assert.equal(body(result).error, "invalid_redirect_uri");
  });
});

test("dcr: an oversized client_name is rejected", async () => {
  await withServer(async (port, config) => {
    const result = await register(port, config, {
      client_name: "n".repeat(DCR_LIMITS.maxClientNameLength + 1),
      redirect_uris: ["https://agent.example.test/oauth/callback"],
    });
    assert.equal(result.status, 400);
    assert.equal(body(result).error, "invalid_client_metadata");
  });
});

test("dcr: the policy hook leaves no marker property on the registered client", async () => {
  await withServer(async (port, config) => {
    const result = await register(port, config, {
      client_name: "Marker",
      redirect_uris: ["https://agent.example.test/oauth/callback"],
      reachmy_client_policy: "attacker-supplied",
    });
    assert.equal(result.status, 201, result.body);
    assert.equal("reachmy_client_policy" in body(result), false);
  });
});

test("dcr: exceeding the registration rate limit returns an OAuth error, not a crash", async () => {
  await withServer(async (port, config) => {
    let last: HttpResult | null = null;
    for (let attempt = 0; attempt <= DCR_RATE_LIMIT.limit; attempt++) {
      last = await register(port, config, {
        client_name: `Burst-${attempt}`,
        redirect_uris: ["https://agent.example.test/oauth/callback"],
      });
      if (last.status === 429) break;
    }
    assert.ok(last);
    assert.equal(last.status, 429, `expected the limiter to engage, got ${last.status}`);
    assert.equal(body(last).error, "temporarily_unavailable");
    assert.ok(last.headers["retry-after"], "expected a Retry-After header");
  });
});

test("dcr: registered clients are stamped so they can be retired later", async () => {
  await withServer(async (port, config) => {
    const db = await testDb();
    const result = await register(port, config, {
      client_name: "Stamped",
      redirect_uris: ["https://agent.example.test/oauth/callback"],
    });
    assert.equal(result.status, 201, result.body);
    const clientId = String(body(result).client_id);

    const [row] = await db
      .select()
      .from(oauthModels)
      .where(and(eq(oauthModels.model, "Client"), eq(oauthModels.id, clientId)));
    assert.ok(row, "expected the client row to exist");
    assert.equal(typeof row.payload.registered_at, "string");
  });
});

test("dcr: retention retires never-authorized clients and spares the rest", async () => {
  const db = await testDb();
  const tag = suffix();
  const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date().toISOString();

  const abandoned = `retain_abandoned_${tag}`;
  const granted = `retain_granted_${tag}`;
  const fresh = `retain_fresh_${tag}`;
  const legacy = `retain_legacy_${tag}`;

  await db.insert(oauthModels).values([
    { model: "Client", id: abandoned, payload: { registered_at: old } },
    { model: "Client", id: granted, payload: { registered_at: old } },
    { model: "Client", id: fresh, payload: { registered_at: recent } },
    { model: "Client", id: legacy, payload: {} },
    {
      model: "Grant",
      id: `retain_grant_${tag}`,
      payload: { clientId: granted, accountId: `acct_${tag}` },
    },
  ]);

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await purgeUnauthorizedClients(db, { registeredBefore: cutoff });

  const survivors = await db
    .select({ id: oauthModels.id })
    .from(oauthModels)
    .where(eq(oauthModels.model, "Client"));
  const ids = new Set(survivors.map((row) => row.id));

  assert.equal(ids.has(abandoned), false, "a client that never obtained a grant should be retired");
  assert.equal(ids.has(granted), true, "an authorized client must never be retired");
  assert.equal(ids.has(fresh), true, "a recently registered client must not be retired");
  assert.equal(ids.has(legacy), true, "a client registered before stamping must not be retired");
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
