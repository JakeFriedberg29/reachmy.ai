import type { IncomingMessage } from "node:http";
import { verifyClerkJwt } from "../auth/clerk.js";
import { decodeSessionCookie, readCookie, SESSION_COOKIE } from "../auth/session-cookie.js";
import { verifyScriptToken } from "../auth/script-token.js";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { upsertAccountByClerkUser } from "../domain/identity.js";

/**
 * Resolve the ReachMy account for general Portal/API browser requests.
 * Accepts: Clerk JWT bearer, `an_session` cookie, or `anp1.*` script tokens.
 */
export async function resolveAccountIdFromRequest(
  req: IncomingMessage,
  config: AppConfig,
  db: Database,
): Promise<string | null> {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    const fromBearer = await resolveAccountIdFromBearer(token, config, db, { allowScriptToken: true });
    if (fromBearer) return fromBearer;
  }
  return decodeSessionCookie(readCookie(req.headers.cookie, SESSION_COOKIE), config.cookieKeys[0]!);
}

/**
 * Human Portal session only — for platform-admin and future `/v1/admin/*`.
 * Accepts: Clerk JWT bearer (human sign-in) or `an_session` cookie (post-Clerk bridge).
 * Rejects: MCP/OAuth AS access tokens, script tokens, and any other bearer type.
 */
export async function resolveHumanPortalAccountIdFromRequest(
  req: IncomingMessage,
  config: AppConfig,
  db: Database,
): Promise<string | null> {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    const fromBearer = await resolveAccountIdFromBearer(token, config, db, { allowScriptToken: false });
    if (fromBearer) return fromBearer;
  }
  return decodeSessionCookie(readCookie(req.headers.cookie, SESSION_COOKIE), config.cookieKeys[0]!);
}

async function resolveAccountIdFromBearer(
  token: string,
  config: AppConfig,
  db: Database,
  opts: { allowScriptToken: boolean },
): Promise<string | null> {
  if (opts.allowScriptToken && token.startsWith("anp1.")) {
    return verifyScriptToken(token, config.cookieKeys[0]!);
  }
  try {
    const payload = await verifyClerkJwt(config, token);
    if (payload.sub) {
      const identity = await upsertAccountByClerkUser(db, {
        clerkUserId: payload.sub,
        email: typeof payload.email === "string" ? payload.email : null,
      });
      return identity.account_id;
    }
  } catch {
    // Not a Clerk JWT — includes ReachMy MCP/OAuth access tokens (issuer mcp.reachmy.ai).
  }
  return null;
}
