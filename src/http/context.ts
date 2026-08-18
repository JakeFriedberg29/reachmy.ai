import type { Context, Next } from "hono";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { verifyClerkJwt } from "../auth/clerk.js";
import { decodeSessionCookie, readCookie, SESSION_COOKIE } from "../auth/session-cookie.js";
import { verifyScriptToken } from "../auth/script-token.js";
import { DomainError } from "../domain/errors.js";
import { getIdentityByAccountId, requireActorPrincipal, upsertAccountByClerkUser } from "../domain/identity.js";
import type { Actor } from "../domain/types.js";

export type AppEnv = {
  Variables: {
    db: Database;
    config: AppConfig;
    accountId: string | null;
    actor: Actor | null;
  };
};

function bearer(c: Context): string | null {
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

export async function resolveAccountId(
  c: Context<AppEnv>,
  config: AppConfig,
  db: Database,
): Promise<string | null> {
  const token = bearer(c);
  if (token?.startsWith("anp1.")) {
    return verifyScriptToken(token, config.cookieKeys[0]!);
  }
  if (token) {
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
      // Not a Clerk JWT.
    }
  }
  return decodeSessionCookie(readCookie(c.req.header("cookie"), SESSION_COOKIE), config.cookieKeys[0]!);
}

export function errorJson(c: Context, error: unknown) {
  if (error instanceof DomainError) {
    return c.json({ error: error.code, message: error.message }, error.status as 400);
  }
  console.error(error);
  return c.json({ error: "internal_error", message: "Internal error" }, 500);
}

export async function requireAccount(c: Context<AppEnv>, next: Next) {
  const accountId = c.get("accountId");
  if (!accountId) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  await next();
}

export async function requireActor(c: Context<AppEnv>, next: Next) {
  const db = c.get("db");
  const accountId = c.get("accountId");
  if (!accountId) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  try {
    c.set("actor", await requireActorPrincipal(db, accountId));
  } catch (error) {
    return errorJson(c, error);
  }
  await next();
}

export async function optionalIdentity(c: Context<AppEnv>) {
  const db = c.get("db");
  const accountId = c.get("accountId");
  if (!accountId) return null;
  return getIdentityByAccountId(db, accountId);
}
