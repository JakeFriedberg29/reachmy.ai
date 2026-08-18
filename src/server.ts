import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import type { Context } from "hono";
import type { AppConfig } from "./config.js";
import type { Database } from "./db/client.js";
import type { SigningJwks } from "./db/jwks.js";
import { createDrizzleAdapter } from "./auth/drizzle-adapter.js";
import { createOidcProvider, logOauth, mcpResource, SCOPES } from "./auth/oidc.js";
import { createTokenVerifier } from "./auth/verify-token.js";
import { createPhaseMinus1McpServer } from "./mcp/server.js";
import { resolveAccountId, type AppEnv } from "./http/context.js";
import { createV1Routes } from "./http/v1.js";
import { listConnections } from "./domain/identity.js";
import { requireActorPrincipal } from "./domain/identity.js";
import {
  handleInteraction,
  handleInvitePost,
  renderDevCallback,
  renderInvite,
  renderRecovery,
  renderSecurity,
  renderSignIn,
} from "./web.js";

export async function createHttpServer(config: AppConfig, db: Database, jwks: SigningJwks) {
  const adapter = createDrizzleAdapter(db);
  const provider = createOidcProvider(config, db, adapter, jwks);
  const oidc = provider.callback();
  const verifyAccessToken = createTokenVerifier(config, db);
  const resource = mcpResource(config.publicUrl);
  const mcpHandler = createMcpHandler(() => createPhaseMinus1McpServer(null));

  const app = createMcpHonoApp({
    host: "0.0.0.0",
    allowedHosts: config.allowedHosts,
  });

  app.use("*", async (c, next) => {
    const ctx = c as unknown as Context<AppEnv>;
    ctx.set("db", db);
    ctx.set("config", config);
    ctx.set("actor", null);
    ctx.set("accountId", await resolveAccountId(ctx, config, db));
    await next();
  });

  app.route("/", createV1Routes());

  app.get("/health", (c) =>
    c.json({
      ok: true,
      phase: 0,
      mcp: "/mcp",
      resource,
      issuer: config.publicUrl,
      allowedHosts: config.allowedHosts,
    }),
  );

  app.get("/", (c) =>
    c.json({
      name: "reachmy.ai",
      phase: 0,
      message: "Network core. Website is sign-in, OAuth consent, invite fallback, and security only.",
      endpoints: {
        health: "/health",
        mcp: "/mcp",
        sign_in: "/sign-in",
        invite: "/invite/:token",
        v1: "/v1",
        resource_metadata: "/.well-known/oauth-protected-resource",
        authorization_server: "/.well-known/oauth-authorization-server",
      },
    }),
  );

  const protectedResourceMetadata = {
    resource,
    authorization_servers: [config.publicUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: SCOPES.split(" "),
  };

  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResourceMetadata));

  app.get("/sign-in", (c) => {
    const redirect = c.req.query("redirect") || "/security";
    c.header("content-type", "text/html; charset=utf-8");
    return c.html(renderSignIn(config, redirect));
  });

  app.get("/recovery", (c) => {
    c.header("content-type", "text/html; charset=utf-8");
    return c.html(renderRecovery());
  });

  app.get("/security", async (c) => {
    c.header("content-type", "text/html; charset=utf-8");
    const accountId = (c as unknown as Context<AppEnv>).get("accountId");
    if (!accountId) return c.html(renderSignIn(config, "/security"));
    try {
      const actor = await requireActorPrincipal(db, accountId);
      const connections = await listConnections(db, actor.principalId);
      return c.html(
        renderSecurity(
          connections.map((row) => ({
            id: row.id,
            displayLabel: row.displayLabel,
            status: row.status,
            grantId: row.grantId,
          })),
        ),
      );
    } catch {
      return c.html(renderSignIn(config, "/security"));
    }
  });

  app.get("/invite/:token", (c) => {
    c.header("content-type", "text/html; charset=utf-8");
    return c.html(renderInvite(c.req.param("token")));
  });

  app.get("/dev/callback", (c) => {
    c.header("content-type", "text/html; charset=utf-8");
    return c.html(renderDevCallback(config, new URL(c.req.url).searchParams));
  });

  const wwwAuthenticate = `Bearer realm="reachmy.ai", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource", scope="identity:read interactions:write offline_access"`;

  app.all("/mcp", async (c: Context) => {
    const authorization = c.req.header("authorization");
    const principal = await verifyAccessToken(authorization);
    if (!principal) {
      return c.json(
        { error: "invalid_token", error_description: "Missing or invalid access token" },
        401,
        { "WWW-Authenticate": wwwAuthenticate },
      );
    }
    const authedHandler = createMcpHandler(() => createPhaseMinus1McpServer(principal));
    return authedHandler.fetch(c.req.raw, {
      parsedBody: c.get("parsedBody"),
      authInfo: {
        token: authorization?.slice("Bearer ".length) ?? "",
        clientId: principal.clientId ?? "oauth",
        scopes: ["identity:read", "interactions:write", "offline_access"],
        extra: {
          account_id: principal.accountId,
          principal_id: principal.principalId,
        },
      },
    });
  });

  void mcpHandler;

  const honoListener = getRequestListener(app.fetch);

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const originalEnd = res.end.bind(res);
    res.end = ((...args: Parameters<ServerResponse["end"]>) => {
      const path = req.url ?? "/";
      if (path.startsWith("/auth") || path.startsWith("/interaction") || path.startsWith("/reg") || path.startsWith("/token")) {
        logOauth("http_done", {
          method: req.method,
          path,
          status: res.statusCode,
          location: res.getHeader("location") ? String(res.getHeader("location")) : null,
          ms: Date.now() - started,
        });
      }
      return originalEnd(...args);
    }) as ServerResponse["end"];

    const path = req.url?.split("?")[0] ?? "/";
    if (req.method === "POST" && path.startsWith("/invite/")) {
      const token = decodeURIComponent(path.slice("/invite/".length));
      await handleInvitePost(db, config, req, res, token);
      return;
    }
    const honoPrefixes = ["/v1", "/sign-in", "/recovery", "/security", "/invite/"];
    const honoPaths = [
      "/",
      "/health",
      "/mcp",
      "/dev/callback",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ];
    if (
      honoPaths.includes(path) ||
      path.startsWith("/interaction/") ||
      honoPrefixes.some((prefix) => path === prefix || path.startsWith(prefix === "/v1" ? "/v1" : prefix))
    ) {
      if (path.startsWith("/interaction/")) {
        try {
          const handled = await handleInteraction(provider, config, db, req, res);
          if (handled) return;
        } catch (error) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "interaction_error", detail: String(error) }));
          return;
        }
      }
      return honoListener(req, res);
    }
    return oidc(req, res);
  });
}
