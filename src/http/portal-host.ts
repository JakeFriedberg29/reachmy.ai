import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { clerkFrontendApi, verifyClerkJwt } from "../auth/clerk.js";
import {
  appendClearSessionCookieHeader,
  portalSessionCookieSecure,
  sessionCookieHeader,
} from "../auth/session-cookie.js";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { accounts } from "../db/schema.js";
import { DomainError } from "../domain/errors.js";
import { upsertAccountByClerkUser } from "../domain/identity.js";
import { toPortalOverviewResponse, listPortalAiConnections } from "../domain/portal-connections.js";
import { requirePlatformAdmin } from "../domain/platform-admin.js";
import { resolveHumanPortalAccountIdFromRequest } from "./portal-request.js";
import {
  renderPortalAccount,
  renderPortalConnectClaude,
  renderPortalHome,
  renderPortalSignIn,
  renderPortalSignOut,
} from "./portal-ui.js";

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(html);
}

function redirect(res: ServerResponse, location: string, status = 302): void {
  res.statusCode = status;
  res.setHeader("location", location);
  res.setHeader("cache-control", "no-store");
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeReturnPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export function respondPortalInvalidHost(res: ServerResponse): void {
  sendJson(res, 421, { error: "invalid_host", message: "Unrecognized host" });
}

export function respondPortalNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "not_found", message: "Not found on Portal host" });
}

export function respondPortalHealth(res: ServerResponse, config: AppConfig): void {
  sendJson(res, 200, {
    ok: true,
    phase: 3,
    slice: 6,
    surface: "portal",
    portal_url: config.portalUrl,
    issuer: config.publicUrl,
    allowed_hosts: config.allowedHosts,
  });
}

export function respondPortalAdminStub(res: ServerResponse): void {
  sendHtml(
    res,
    200,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>ReachMy Admin</title></head><body><h1>ReachMy Admin</h1><p>Platform administration</p></body></html>`,
  );
}

export function respondPortalAdminForbidden(res: ServerResponse): void {
  sendJson(res, 403, { error: "forbidden", message: "Platform admin access required" });
}

export function respondPortalUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, { error: "unauthorized", message: "Sign in required" });
}

export async function handlePortalOverview(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  db: Database,
): Promise<void> {
  const accountId = await resolveHumanPortalAccountIdFromRequest(req, config, db);
  if (!accountId) {
    respondPortalUnauthorized(res);
    return;
  }
  const view = await listPortalAiConnections(db, accountId);
  sendJson(res, 200, toPortalOverviewResponse(view));
}

export async function handlePortalHome(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  db: Database,
): Promise<void> {
  const accountId = await resolveHumanPortalAccountIdFromRequest(req, config, db);
  if (!accountId) {
    redirect(res, "/sign-in");
    return;
  }
  const view = await listPortalAiConnections(db, accountId);
  sendHtml(res, 200, renderPortalHome(toPortalOverviewResponse(view)));
}

export async function handlePortalSignIn(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  db: Database,
): Promise<void> {
  const accountId = await resolveHumanPortalAccountIdFromRequest(req, config, db);
  const url = new URL(req.url ?? "/sign-in", config.portalUrl);
  const redirectTo = safeReturnPath(url.searchParams.get("redirect") ?? url.searchParams.get("return"));
  if (accountId) {
    redirect(res, redirectTo);
    return;
  }
  sendHtml(res, 200, renderPortalSignIn(config, redirectTo));
}

export async function handlePortalConnectClaude(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  db: Database,
): Promise<void> {
  const accountId = await resolveHumanPortalAccountIdFromRequest(req, config, db);
  if (!accountId) {
    redirect(res, `/sign-in?redirect=${encodeURIComponent("/connect/claude")}`);
    return;
  }
  sendHtml(res, 200, renderPortalConnectClaude());
}

export async function handlePortalAccount(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  db: Database,
): Promise<void> {
  const accountId = await resolveHumanPortalAccountIdFromRequest(req, config, db);
  if (!accountId) {
    redirect(res, `/sign-in?redirect=${encodeURIComponent("/account")}`);
    return;
  }
  const [account] = await db
    .select({ email: accounts.email })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const view = await listPortalAiConnections(db, accountId);
  const overview = toPortalOverviewResponse(view);
  sendHtml(
    res,
    200,
    renderPortalAccount({
      email: account?.email ?? null,
      agentName: overview.agent_name_status === "claimed" ? overview.agent_name : null,
    }),
  );
}

export async function handlePortalSignOut(
  _req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
): Promise<void> {
  appendClearSessionCookieHeader(res, config);
  sendHtml(res, 200, renderPortalSignOut(config));
}

/**
 * Portal-host Clerk bridge — same account upsert + an_session mint as MCP `/v1/auth/clerk`,
 * with Portal-appropriate Secure cookie attributes.
 */
export async function handlePortalClerkAuth(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  db: Database,
): Promise<void> {
  const raw = await readBody(req);
  let token: string | null = null;
  try {
    const body = JSON.parse(raw || "{}") as { token?: unknown };
    token = typeof body.token === "string" ? body.token : null;
  } catch {
    token = null;
  }
  if (!token) {
    const authorization = req.headers.authorization;
    if (authorization?.startsWith("Bearer ")) {
      token = authorization.slice("Bearer ".length).trim();
    }
  }
  if (!token) {
    sendJson(res, 401, { error: "unauthorized", message: "Clerk token required" });
    return;
  }
  try {
    const payload = await verifyClerkJwt(config, token);
    if (!payload.sub) {
      sendJson(res, 401, { error: "unauthorized", message: "Clerk subject missing" });
      return;
    }
    const identity = await upsertAccountByClerkUser(db, {
      clerkUserId: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
    });
    res.setHeader(
      "set-cookie",
      sessionCookieHeader(
        identity.account_id,
        config.cookieKeys[0]!,
        portalSessionCookieSecure(config),
      ),
    );
    sendJson(res, 200, {
      identity,
      clerk_frontend_api: clerkFrontendApi(config.clerkPublishableKey),
    });
  } catch (error) {
    if (error instanceof DomainError) {
      sendJson(res, error.status, { error: error.code, message: error.message });
      return;
    }
    sendJson(res, 401, { error: "unauthorized", message: "Invalid Clerk token" });
  }
}

export async function handlePortalAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  db: Database,
): Promise<void> {
  const accountId = await resolveHumanPortalAccountIdFromRequest(req, config, db);
  if (!accountId) {
    respondPortalUnauthorized(res);
    return;
  }
  try {
    await requirePlatformAdmin(db, accountId);
    respondPortalAdminStub(res);
  } catch (error) {
    if (error instanceof DomainError && error.status === 403) {
      respondPortalAdminForbidden(res);
      return;
    }
    if (error instanceof DomainError) {
      sendJson(res, error.status, { error: error.code, message: error.message });
      return;
    }
    sendJson(res, 500, { error: "internal_error", message: "Internal error" });
  }
}

/** Dispatch an allowlisted Portal-host request. */
export async function dispatchPortalRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  db: Database,
  path: string,
): Promise<void> {
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/health") {
    respondPortalHealth(res, config);
    return;
  }
  if (method === "GET" && path === "/v1/portal/overview") {
    await handlePortalOverview(req, res, config, db);
    return;
  }
  if (method === "POST" && path === "/v1/auth/clerk") {
    await handlePortalClerkAuth(req, res, config, db);
    return;
  }
  if (method === "GET" && path === "/") {
    await handlePortalHome(req, res, config, db);
    return;
  }
  if (method === "GET" && path === "/sign-in") {
    await handlePortalSignIn(req, res, config, db);
    return;
  }
  if (method === "POST" && path === "/sign-out") {
    await handlePortalSignOut(req, res, config);
    return;
  }
  if (method === "GET" && path === "/account") {
    await handlePortalAccount(req, res, config, db);
    return;
  }
  if (method === "GET" && path === "/connect/claude") {
    await handlePortalConnectClaude(req, res, config, db);
    return;
  }
  if (method === "GET" && path === "/admin") {
    await handlePortalAdmin(req, res, config, db);
    return;
  }
  respondPortalNotFound(res);
}
