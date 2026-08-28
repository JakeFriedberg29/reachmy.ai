import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import type { Context } from "hono";
import { isProductionRuntime, type AppConfig } from "./config.js";
import type { Database } from "./db/client.js";
import type { SigningJwks } from "./db/jwks.js";
import { createDrizzleAdapter } from "./auth/drizzle-adapter.js";
import { resolveBrowserAccountId } from "./auth/browser-account.js";
import { sessionCookieHeader } from "./auth/session-cookie.js";
import { createOidcProvider, logOauth, mcpResource, SCOPES } from "./auth/oidc.js";
import { createTokenVerifier } from "./auth/verify-token.js";
import { createNetworkMcpServer } from "./mcp/server.js";
import {
  describeJsonRpc,
  logMcp,
  newMcpRequestId,
  traceResponseBody,
  truncate,
} from "./mcp/observability.js";
import { resolveAccountId, type AppEnv } from "./http/context.js";
import {
  classifyRequestHost,
  isMcpBackendPath,
  isPortalHostAllowedPath,
  normalizeHostname,
  safeReturnPath,
} from "./http/host.js";
import {
  dispatchPortalRequest,
  respondPortalInvalidHost,
  respondPortalNotFound,
} from "./http/portal-host.js";
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
      phase: 1,
      surface: "mcp",
      mcp: "/mcp",
      resource,
      issuer: config.publicUrl,
      allowedHosts: config.allowedHosts,
      portalHost: config.portalHost,
    }),
  );

  app.get("/", (c) =>
    c.json({
      name: "reachmy.ai",
      phase: 1,
      message: "Network core with MCP tools. Website is sign-in, OAuth consent, invite fallback, and security only.",
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

  app.get("/sign-in", async (c) => {
    const redirect = safeReturnPath(c.req.query("redirect"), "/security");
    const resolved = await resolveBrowserAccountId(c.req.raw, config, db);
    if (resolved) {
      if (resolved.mintedSession) {
        c.header(
          "set-cookie",
          sessionCookieHeader(
            resolved.accountId,
            config.cookieKeys[0]!,
            config.publicUrl.startsWith("https"),
          ),
        );
      }
      return c.redirect(redirect);
    }
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

  // Renders authorization responses on the developer's own screen during local spikes. It has no
  // production purpose, and production also ships without the static client that targets it.
  const devCallbackEnabled = !isProductionRuntime(config.publicUrl);
  if (devCallbackEnabled) {
    app.get("/dev/callback", (c) => {
      c.header("content-type", "text/html; charset=utf-8");
      return c.html(renderDevCallback(config, new URL(c.req.url).searchParams));
    });
  }

  const wwwAuthenticate = `Bearer realm="reachmy.ai", resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource", scope="identity:read interactions:write offline_access"`;

  app.all("/mcp", async (c: Context) => {
    const requestId = newMcpRequestId();
    const startedAt = Date.now();
    const authorization = c.req.header("authorization");

    logMcp("mcp_request_received", {
      request_id: requestId,
      http_method: c.req.method,
      accept: truncate(c.req.header("accept")),
      content_type: truncate(c.req.header("content-type")),
      mcp_protocol_version: truncate(c.req.header("mcp-protocol-version")),
      has_mcp_session_id: Boolean(c.req.header("mcp-session-id")),
      has_authorization: Boolean(authorization),
      // Descriptive only (locked principle 13): identifies which AI is calling in the logs.
      user_agent: truncate(c.req.header("user-agent"), 120),
    });

    const principal = await verifyAccessToken(authorization);
    logMcp("mcp_token_verified", {
      request_id: requestId,
      ok: Boolean(principal),
      client_id: principal?.clientId ?? null,
      grant_id: principal?.grantId ?? null,
      has_connection: Boolean(principal?.connectionId),
      onboarding: principal?.onboarding ?? null,
      token_scopes: principal?.scopes ?? [],
      ms: Date.now() - startedAt,
    });

    if (!principal) {
      logMcp("mcp_response_completed", {
        request_id: requestId,
        status: 401,
        streamed: false,
        completed: true,
        bytes: null,
        reason: "invalid_token",
        ms: Date.now() - startedAt,
      });
      return c.json(
        { error: "invalid_token", error_description: "Missing or invalid access token" },
        401,
        { "WWW-Authenticate": wwwAuthenticate },
      );
    }

    logMcp("mcp_method_received", {
      request_id: requestId,
      client_id: principal.clientId,
      grant_id: principal.grantId,
      ...describeJsonRpc(c.get("parsedBody")),
    });

    const authedHandler = createMcpHandler(() =>
      createNetworkMcpServer({ db, principal, publicUrl: config.publicUrl, requestId }),
    );
    const response = await authedHandler.fetch(c.req.raw, {
      parsedBody: c.get("parsedBody"),
      authInfo: {
        token: authorization?.slice("Bearer ".length) ?? "",
        clientId: principal.clientId ?? "oauth",
        scopes: principal.scopes,
        extra: {
          account_id: principal.accountId,
          principal_id: principal.principalId,
        },
      },
    });

    const contentType = response.headers.get("content-type");
    const streamed = Boolean(response.body);
    logMcp("mcp_response_started", {
      request_id: requestId,
      status: response.status,
      content_type: truncate(contentType),
      streamed,
      ms: Date.now() - startedAt,
    });

    return traceResponseBody(response, (outcome) => {
      logMcp("mcp_response_completed", {
        request_id: requestId,
        status: response.status,
        content_type: truncate(contentType),
        streamed,
        completed: outcome.completed,
        bytes: outcome.bytes,
        reason: outcome.reason,
        ms: Date.now() - startedAt,
      });
    });
  });

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
      // The socket actually ending is the ground truth an SSE exchange completed; its absence is
      // the signature of a hung MCP response.
      if (path.startsWith("/mcp")) {
        logMcp("mcp_http_done", {
          method: req.method,
          path,
          status: res.statusCode,
          ms: Date.now() - started,
        });
      }
      return originalEnd(...args);
    }) as ServerResponse["end"];

    const path = req.url?.split("?")[0] ?? "/";
    const hostname = normalizeHostname(req.headers.host);
    const hostKind = classifyRequestHost(hostname, config);

    if (hostKind === "unknown") {
      respondPortalInvalidHost(res);
      return;
    }

    if (hostKind === "portal") {
      const method = req.method ?? "GET";
      if (isPortalHostAllowedPath(method, path)) {
        await dispatchPortalRequest(req, res, config, db, path);
        return;
      }
      if (isMcpBackendPath(path)) {
        respondPortalNotFound(res);
        return;
      }
      respondPortalNotFound(res);
      return;
    }

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
      ...(devCallbackEnabled ? ["/dev/callback"] : []),
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
