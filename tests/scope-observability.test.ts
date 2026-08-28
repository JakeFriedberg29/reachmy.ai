import assert from "node:assert/strict";
import { decodeJwt } from "jose";
import { test } from "node:test";
import type { AppConfig } from "../src/config.js";
import { setClerkBrowserSessionResolverForTests } from "../src/auth/browser-account.js";
import { SCOPES } from "../src/auth/oidc.js";
import {
  ALL_MCP_TOOLS,
  evaluateToolScope,
  parseScopeString,
  TOOL_REQUIRED_SCOPES,
} from "../src/auth/scope-map.js";
import {
  assertScopeObservationSafe,
  buildScopeAuthorizationObservation,
  scopesExpanded,
} from "../src/auth/scope-observability.js";
import { createTokenVerifier } from "../src/auth/verify-token.js";
import { executeTool, type McpToolContext } from "../src/mcp/tools.js";
import type { VerifiedPrincipal } from "../src/auth/verify-token.js";
import { upsertAccountByClerkUser } from "../src/domain/identity.js";
import { withServer, withServerOnPublicUrlPort } from "./helpers-http.js";
import { createOauthSession } from "./helpers-oauth-token.js";
import { suffix, testDb } from "./helpers.js";

type OauthLog = Record<string, unknown>;

function captureOauthLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: OauthLog[] }> {
  const logs: OauthLog[] = [];
  const original = console.log;
  console.log = ((msg: unknown, ...rest: unknown[]) => {
    if (typeof msg === "string") {
      try {
        const parsed = JSON.parse(msg) as OauthLog;
        if (parsed.msg === "oauth_debug") logs.push(parsed);
      } catch {
        // not structured oauth output
      }
    }
    return original.call(console, msg, ...rest);
  }) as typeof console.log;
  return fn()
    .then((result) => ({ result, logs }))
    .finally(() => {
      console.log = original;
    });
}

function scopeLogs(logs: OauthLog[], event: string): OauthLog[] {
  return logs.filter((entry) => entry.event === event);
}

async function newAccountId(prefix: string): Promise<string> {
  const db = await testDb();
  const tag = suffix();
  const account = await upsertAccountByClerkUser(db, {
    clerkUserId: `${prefix}_${tag}`,
    email: `${prefix}_${tag}@example.test`,
  });
  return account.account_id;
}

test("scope map: every registered MCP tool has a required scope", () => {
  const registered = [
    "get_my_identity",
    "get_identity",
    "create_identity",
    "resolve_identity",
    "create_invite",
    "accept_invite",
    "list_connections",
    "get_relationship_permissions",
    "set_relationship_permissions",
    "create_interaction",
    "list_pending_interactions",
    "get_interaction",
    "respond_to_interaction",
    "create_proposal",
    "approve_proposal",
    "reject_proposal",
    "list_agent_connections",
    "request_disconnect_agent",
    "revoke_agent_connection",
  ];
  assert.deepEqual([...ALL_MCP_TOOLS].sort(), [...registered].sort());
  for (const tool of registered) {
    assert.ok(TOOL_REQUIRED_SCOPES[tool], `missing scope mapping for ${tool}`);
  }
});

test("scope map: evaluateToolScope detects missing scopes without enforcing", () => {
  const narrow = ["identity:read"];
  assert.equal(evaluateToolScope("get_my_identity", narrow).wouldDeny, false);
  assert.equal(evaluateToolScope("create_invite", narrow).wouldDeny, true);
  assert.equal(evaluateToolScope("create_invite", narrow).requiredScope, "contacts:write");
});

test("scope observability: scopesExpanded compares requested vs granted", () => {
  assert.equal(scopesExpanded(["identity:read"], ["identity:read", "contacts:read"]), true);
  assert.equal(scopesExpanded(["identity:read", "contacts:read"], ["identity:read"]), false);
});

test("scope observability: observation payloads reject sensitive fields", () => {
  assert.throws(() =>
    assertScopeObservationSafe({
      client_id: "client-1",
      access_token: "secret",
    }),
  );
  assert.doesNotThrow(() =>
    assertScopeObservationSafe({
      client_id: "client-1",
      requested_scopes: ["identity:read"],
      granted_oidc_scopes: ["openid", "identity:read"],
    }),
  );
});

test("scope observability: authorization records requested and granted scopes", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const narrowScope = "identity:read interactions:write";
    const { result, logs } = await captureOauthLogs(async () => {
      const session = createOauthSession(port, config, await newAccountId("scope_obs_auth"));
      const clientId = await session.register({ client_name: "Scope-Obs-AI" });
      const stop = await session.authorize({ clientId, scope: narrowScope });
      assert.equal(stop.kind, "interaction");
      const allow = stop.kind === "interaction" ? stop.formActions[0] : null;
      assert.ok(allow);
      const done = await session.submit(allow);
      assert.equal(done.kind, "callback");
      return { clientId, done };
    });

    const authLogs = scopeLogs(logs, "scope_authorization_observed");
    assert.equal(authLogs.length, 1);
    const observed = authLogs[0]!;
    assert.equal(observed.client_name, "Scope-Obs-AI");
    assert.deepEqual(observed.requested_scopes, parseScopeString(narrowScope));
    assert.ok(
      observed.granted_resource_scopes &&
        typeof observed.granted_resource_scopes === "object" &&
        !Array.isArray(observed.granted_resource_scopes),
    );
    const resourceScopes = Object.values(
      observed.granted_resource_scopes as Record<string, string[]>,
    ).flat();
    assert.ok(resourceScopes.includes("identity:read"));
    assert.ok(resourceScopes.includes("contacts:read"));
    assert.equal(observed.scope_expanded, true);
    assert.equal(observed.flow_kind, "initial_authorization");
    assert.equal(result.done.kind, "callback");

    const serialized = JSON.stringify(observed);
    assert.doesNotMatch(serialized, /access_token|refresh_token|authorization_code|code_verifier/i);
  });
});

test("scope observability: token issuance records scopes on access token", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const narrowScope = "identity:read offline_access";
    const { logs, result } = await captureOauthLogs(async () => {
      const session = createOauthSession(port, config, await newAccountId("scope_obs_token"));
      const clientId = await session.register();
      let stop = await session.authorize({ clientId, scope: narrowScope });
      for (let approvals = 0; stop.kind === "interaction" && approvals < 4; approvals++) {
        const allow = stop.formActions[0];
        if (!allow) throw new Error("missing allow form");
        stop = await session.submit(allow);
      }
      assert.equal(stop.kind, "callback");
      assert.ok(stop.kind === "callback" && stop.code);
      const tokens = await session.exchange({ clientId, code: stop.code });
      return { tokens, clientId };
    });

    const tokenLogs = scopeLogs(logs, "scope_token_observed");
    assert.ok(tokenLogs.some((entry) => entry.flow_kind === "authorization_code"));
    const codeLog = tokenLogs.find((entry) => entry.flow_kind === "authorization_code")!;
    assert.ok(Array.isArray(codeLog.token_scopes));
    const tokenScopes = codeLog.token_scopes as string[];
    assert.ok(tokenScopes.includes("identity:read"));

    const refreshToken = result.tokens.refresh_token;
    assert.equal(typeof refreshToken, "string");

    const { logs: refreshLogs } = await captureOauthLogs(async () =>
      sessionRefresh(port, config, result.clientId, refreshToken as string),
    );
    const refreshObserved = scopeLogs(refreshLogs, "scope_token_observed").find(
      (entry) => entry.flow_kind === "refresh",
    );
    assert.ok(refreshObserved);
    assert.ok(Array.isArray(refreshObserved!.token_scopes));
  });
});

async function sessionRefresh(
  port: number,
  config: AppConfig,
  clientId: string,
  refreshToken: string,
) {
  const session = createOauthSession(port, config, null);
  return session.refresh({ clientId, refreshToken });
}

// Bound to the PUBLIC_URL port because the verifier fetches `${PUBLIC_URL}/jwks`, and the token
// it checks is issued for that same issuer. On an ephemeral port this passed only when a separate
// `pnpm dev` happened to be serving 3000.
test("scope observability: verify-token exposes scopes from JWT access token", async () => {
  await withServerOnPublicUrlPort(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const session = createOauthSession(port, config, await newAccountId("scope_verify"));
    const clientId = await session.register();
    let stop = await session.authorize({ clientId, scope: "identity:read contacts:read" });
    for (let approvals = 0; stop.kind === "interaction" && approvals < 4; approvals++) {
      const allow = stop.formActions[0];
      if (!allow) throw new Error("missing allow form");
      stop = await session.submit(allow);
    }
    assert.equal(stop.kind, "callback");
    assert.ok(stop.kind === "callback" && stop.code);
    const tokens = await session.exchange({ clientId, code: stop.code });
    const accessToken = tokens.access_token;
    assert.equal(typeof accessToken, "string");

    const db = await testDb();
    const verify = createTokenVerifier({ ...config, publicUrl: config.publicUrl }, db);
    const principal = await verify(`Bearer ${accessToken}`);
    assert.ok(principal);
    assert.ok(principal!.scopes.length > 0);
    assert.ok(principal!.scopes.includes("identity:read"));

    const payload = decodeJwt(accessToken as string);
    assert.deepEqual(principal!.scopes, parseScopeString(typeof payload.scope === "string" ? payload.scope : null));
  });
});

test("scope observability: report-only MCP check logs would-deny without blocking tools", async () => {
  const db = await testDb();
  const account = await upsertAccountByClerkUser(db, { clerkUserId: `scope_mcp_${suffix()}` });
  const principal: VerifiedPrincipal = {
    accountId: account.account_id,
    principalId: "",
    handle: "",
    displayName: "",
    grantId: `grant:${suffix()}`,
    clientId: `client:${suffix()}`,
    connectionId: null,
    onboarding: "ONBOARDING_REQUIRED",
    scopes: ["identity:read"],
  };
  const ctx: McpToolContext = { db, principal, publicUrl: "http://localhost:3000" };

  const { logs } = await captureOauthLogs(async () => {
    const result = await executeTool(ctx, "create_identity", {
      agent_name: `@scope${suffix()}`,
      display_name: "Scope Reporter",
    });
    assert.notEqual(result.isError, true);
  });

  const wouldDeny = scopeLogs(logs, "scope_mcp_would_deny");
  assert.ok(wouldDeny.some((entry) => entry.tool === "create_identity"));
  assert.equal(wouldDeny[0]!.required_scope, "identity:write");
});

test("scope observability: OAuth consent, DCR, and PKCE behavior remain intact", async () => {
  await withServer(async (port, config) => {
    setClerkBrowserSessionResolverForTests(async () => null);
    const session = createOauthSession(port, config, await newAccountId("scope_regress"));
    const clientId = await session.register({ client_name: "Regression-AI" });
    const stop = await session.authorize({ clientId });
    assert.equal(stop.kind, "interaction");
    assert.match(stop.kind === "interaction" ? stop.body : "", /Regression-AI/);
    assert.match(stop.kind === "interaction" ? stop.body : "", /identity:read/);
  });
});

test("scope observability: buildScopeAuthorizationObservation mirrors grant expansion", () => {
  const details = {
    params: { client_id: "c1", scope: "identity:read" },
    prompt: { name: "consent", reasons: [], details: {} },
    grantId: undefined,
    uid: "uid",
    returnTo: "/resume",
    session: undefined,
  } as never;
  const grant = {
    getOIDCScope: () => "openid identity:read",
    getResourceScope: () => SCOPES,
  };
  const observation = buildScopeAuthorizationObservation({
    details,
    grant,
    clientName: "Test",
    redirectHost: "claude.ai",
    resourceIndicators: ["https://mcp.reachmy.ai/mcp"],
  });
  assert.deepEqual(observation.requested_scopes, ["identity:read"]);
  assert.equal(observation.scope_expanded, true);
  assert.equal(observation.redirect_host, "claude.ai");
});
