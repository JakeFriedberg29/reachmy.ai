import http from "node:http";
import { encodeSessionCookie, SESSION_COOKIE } from "../src/auth/session-cookie.js";
import { hostnameFromUrl, loadConfig } from "../src/config.js";
import { loadOrCreateJwks } from "../src/db/jwks.js";
import { provisionTestPrincipal, upsertAccountByClerkUser } from "../src/domain/identity.js";
import { createHttpServer } from "../src/server.js";
import { suffix, testDb } from "../tests/helpers.js";

type HttpResult = {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
};

type SmokeResult = {
  name: string;
  ok: true;
};

function httpRequest(
  port: number,
  host: string,
  path: string,
  options: { method?: string; cookie?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host };
    if (options.cookie) headers.cookie = options.cookie;
    const req = http.request(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers },
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

function sessionCookie(accountId: string, cookieKey: string): string {
  return `${SESSION_COOKIE}=${encodeSessionCookie(accountId, cookieKey)}`;
}

function assertStatus(res: HttpResult, expected: number, label: string): void {
  if (res.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${res.status} — ${res.body.slice(0, 300)}`);
  }
}

function assertMatch(body: string, pattern: RegExp, label: string): void {
  if (!pattern.test(body)) {
    throw new Error(`${label}: body did not match ${pattern}`);
  }
}

function assertNoSensitiveOverviewFields(json: string): void {
  const patterns: Array<[RegExp, string]> = [
    [/grant_id|oauth_client_id|agent_connection_id|principal_id|account_id|clerk_user_id/i, "internal identity field"],
    [/"id"\s*:/, "raw id property"],
    [/redirect_uri|client_name|client_secret|access_token|refresh_token/i, "oauth metadata"],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(json)) {
      throw new Error(`overview response leaked ${label}`);
    }
  }
}

function assertOverviewDto(body: string): void {
  const overview = JSON.parse(body) as {
    agent_name: string | null;
    agent_name_status: string;
    connections: Array<{ provider: string; label: string; status: string }>;
  };
  if (!["claimed", "not_claimed"].includes(overview.agent_name_status)) {
    throw new Error(`overview agent_name_status invalid: ${overview.agent_name_status}`);
  }
  if (!Array.isArray(overview.connections) || overview.connections.length !== 2) {
    throw new Error("overview connections must include Claude and ChatGPT rows");
  }
  for (const row of overview.connections) {
    if (!["claude", "chatgpt"].includes(row.provider)) {
      throw new Error(`unexpected overview provider: ${row.provider}`);
    }
    if (!row.label || !["connected", "not_connected"].includes(row.status)) {
      throw new Error(`invalid overview connection row: ${JSON.stringify(row)}`);
    }
  }
  assertNoSensitiveOverviewFields(body);
}

async function runCheck(name: string, fn: () => Promise<void>): Promise<SmokeResult> {
  await fn();
  console.log(`  ok  ${name}`);
  return { name, ok: true };
}

async function main() {
  const config = loadConfig();
  const db = await testDb();
  const jwks = await loadOrCreateJwks(db);
  const server = await createHttpServer(config, db, jwks);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected server address");
  }
  const port = address.port;
  const portalHost = config.portalHost;
  const mcpHost = hostnameFromUrl(config.publicUrl);
  const results: SmokeResult[] = [];

  try {
    results.push(
      await runCheck("portal /health → 200 surface=portal", async () => {
        const res = await httpRequest(port, portalHost, "/health");
        assertStatus(res, 200, "portal /health");
        const json = JSON.parse(res.body) as { surface: string; portal_url: string };
        if (json.surface !== "portal") throw new Error(`expected surface portal, got ${json.surface}`);
        if (json.portal_url !== config.portalUrl) {
          throw new Error(`expected portal_url ${config.portalUrl}, got ${json.portal_url}`);
        }
      }),
    );

    results.push(
      await runCheck("portal / → redirect /sign-in", async () => {
        const res = await httpRequest(port, portalHost, "/");
        assertStatus(res, 302, "portal /");
        if (res.headers.location !== "/sign-in") {
          throw new Error(`expected redirect /sign-in, got ${res.headers.location}`);
        }
      }),
    );

    results.push(
      await runCheck("portal /sign-in renders ReachMy + Clerk bridge", async () => {
        const res = await httpRequest(port, portalHost, "/sign-in");
        assertStatus(res, 200, "portal /sign-in");
        assertMatch(res.body, /ReachMy/, "portal /sign-in ReachMy branding");
        assertMatch(res.body, /Sign in/, "portal /sign-in heading");
        assertMatch(res.body, /data-clerk-publishable-key|publishableKey/, "portal /sign-in Clerk publishable key");
        assertMatch(res.body, /clerk\.browser\.js|@clerk\/clerk-js/, "portal /sign-in Clerk JS loader");
        assertMatch(res.body, /initPortalSignIn|mountSignIn/, "portal /sign-in Clerk mount");
        assertMatch(res.body, /\/v1\/auth\/clerk/, "portal /sign-in ReachMy session bridge");
      }),
    );

    results.push(
      await runCheck("portal host blocks /mcp", async () => {
        const res = await httpRequest(port, portalHost, "/mcp", { method: "POST" });
        assertStatus(res, 404, "portal /mcp");
      }),
    );

    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/auth",
    ]) {
      results.push(
        await runCheck(`portal host blocks ${path}`, async () => {
          const res = await httpRequest(port, portalHost, path);
          assertStatus(res, 404, `portal ${path}`);
        }),
      );
    }

    results.push(
      await runCheck("mcp /health → 200 surface=mcp issuer unchanged", async () => {
        const res = await httpRequest(port, mcpHost, "/health");
        assertStatus(res, 200, "mcp /health");
        const json = JSON.parse(res.body) as { surface: string; issuer: string; mcp: string };
        if (json.surface !== "mcp") throw new Error(`expected surface mcp, got ${json.surface}`);
        if (json.issuer !== config.publicUrl) {
          throw new Error(`expected issuer ${config.publicUrl}, got ${json.issuer}`);
        }
        if (json.mcp !== "/mcp") throw new Error(`expected mcp path /mcp, got ${json.mcp}`);
      }),
    );

    const tag = suffix();
    const principal = await provisionTestPrincipal(db, {
      clerkUserId: `portal_smoke_${tag}`,
      handle: `psmoke_${tag}`.slice(0, 30),
      displayName: "Portal Smoke",
    });
    const cookie = sessionCookie(principal.account_id, config.cookieKeys[0]!);

    results.push(
      await runCheck("authenticated GET /v1/portal/overview → safe DTO", async () => {
        const res = await httpRequest(port, portalHost, "/v1/portal/overview", { cookie });
        assertStatus(res, 200, "portal /v1/portal/overview");
        assertOverviewDto(res.body);
        const overview = JSON.parse(res.body) as { agent_name_status: string; agent_name: string | null };
        if (overview.agent_name_status !== "claimed" || !overview.agent_name?.startsWith("@")) {
          throw new Error("expected claimed Agent Name in overview");
        }
      }),
    );

    const user = await upsertAccountByClerkUser(db, {
      clerkUserId: `portal_smoke_user_${tag}`,
      email: `portal_smoke_user_${tag}@example.test`,
    });

    results.push(
      await runCheck("non-admin GET /admin → 403", async () => {
        const res = await httpRequest(port, portalHost, "/admin", {
          cookie: sessionCookie(user.account_id, config.cookieKeys[0]!),
        });
        assertStatus(res, 403, "portal /admin");
        const json = JSON.parse(res.body) as { error: string };
        if (json.error !== "forbidden") throw new Error(`expected forbidden, got ${json.error}`);
      }),
    );

    console.log(
      JSON.stringify({
        ok: true,
        phase: 3,
        slice: 10,
        checks: results.length,
        portal_host: portalHost,
        mcp_host: mcpHost,
      }),
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
