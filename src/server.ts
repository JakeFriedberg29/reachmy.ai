import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import type { Context } from "hono";
import type { AppConfig } from "./config.js";
import { hostnameFromUrl } from "./config.js";
import { createOidcProvider, mcpResource } from "./auth/oidc.js";
import { createTokenVerifier } from "./auth/verify-token.js";
import { createPhaseMinus1McpServer } from "./mcp/server.js";
import { handleInteraction, renderDevCallback } from "./web.js";

export function createHttpServer(config: AppConfig) {
  const provider = createOidcProvider(config);
  const oidc = provider.callback();
  const verifyAccessToken = createTokenVerifier(config);
  const resource = mcpResource(config.publicUrl);
  const host = hostnameFromUrl(config.publicUrl);

  const mcpHandler = createMcpHandler(() => createPhaseMinus1McpServer(null));

  const app = createMcpHonoApp({
    host: "0.0.0.0",
    allowedHosts: [host, "localhost", "127.0.0.1"],
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      phase: -1,
      mcp: "/mcp",
      resource,
      issuer: config.publicUrl,
    }),
  );

  app.get("/", (c) =>
    c.json({
      name: "reachmy.ai",
      phase: "minus-1",
      message: "MCP spike. Connect Claude to POST /mcp. Railway Root Directory is the repository root.",
      endpoints: {
        health: "/health",
        mcp: "/mcp",
        resource_metadata: "/.well-known/oauth-protected-resource",
        authorization_server: "/.well-known/oauth-authorization-server",
      },
    }),
  );

  const protectedResourceMetadata = {
    resource,
    authorization_servers: [config.publicUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: ["identity:read", "interactions:write", "offline_access"],
  };

  app.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResourceMetadata));
  app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json(protectedResourceMetadata),
  );

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
        clientId: "oauth",
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
    const path = req.url?.split("?")[0] ?? "/";
    const honoPaths = [
      "/",
      "/health",
      "/mcp",
      "/dev/callback",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ];
    if (honoPaths.includes(path) || path.startsWith("/interaction/")) {
      if (path.startsWith("/interaction/")) {
        try {
          const handled = await handleInteraction(provider, config, req, res);
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
