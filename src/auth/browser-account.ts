import type { IncomingMessage } from "node:http";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { upsertAccountByClerkUser } from "../domain/identity.js";
import { clerkAuthorizedParties, createClerk } from "./clerk.js";
import { decodeSessionCookie, readCookie, SESSION_COOKIE } from "./session-cookie.js";

export type BrowserAccountResolution = {
  accountId: string;
  /** True when a host-scoped `an_session` was minted from a Clerk browser session. */
  mintedSession: boolean;
};

export type ClerkBrowserSession = {
  clerkUserId: string;
  email?: string | null;
};

type BrowserRequest = IncomingMessage | Request;

let clerkBrowserSessionResolverForTests:
  | ((req: BrowserRequest) => Promise<ClerkBrowserSession | null>)
  | null = null;

/** Test hook — inject a Clerk browser session without real Clerk cookies. */
export function setClerkBrowserSessionResolverForTests(
  resolver: ((req: BrowserRequest) => Promise<ClerkBrowserSession | null>) | null,
): void {
  clerkBrowserSessionResolverForTests = resolver;
}

function cookieHeader(req: BrowserRequest): string | undefined {
  if (req instanceof Request) return req.headers.get("cookie") ?? undefined;
  return req.headers.cookie;
}

function toClerkRequest(req: BrowserRequest, config: AppConfig): Request {
  if (req instanceof Request) return req;
  const url = new URL(req.url ?? "/", config.publicUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }
  return new Request(url, { method: req.method ?? "GET", headers });
}

function emailFromSessionClaims(claims: Record<string, unknown>): string | null {
  if (typeof claims.email === "string" && claims.email) return claims.email;
  if (typeof claims.primary_email_address === "string" && claims.primary_email_address) {
    return claims.primary_email_address;
  }
  return null;
}

async function resolveClerkBrowserSession(
  req: BrowserRequest,
  config: AppConfig,
  db: Database,
): Promise<string | null> {
  if (clerkBrowserSessionResolverForTests) {
    const session = await clerkBrowserSessionResolverForTests(req);
    if (!session) return null;
    const identity = await upsertAccountByClerkUser(db, {
      clerkUserId: session.clerkUserId,
      email: session.email ?? null,
    });
    return identity.account_id;
  }

  const clerk = createClerk(config);
  const state = await clerk.authenticateRequest(toClerkRequest(req, config), {
    authorizedParties: clerkAuthorizedParties(config),
    acceptsToken: "session_token",
  });
  if (!state.isAuthenticated) return null;

  const auth = state.toAuth();
  if (!auth.userId) return null;

  const identity = await upsertAccountByClerkUser(db, {
    clerkUserId: auth.userId,
    email: emailFromSessionClaims((auth.sessionClaims ?? {}) as Record<string, unknown>),
  });
  return identity.account_id;
}

/**
 * Resolve the ReachMy account for MCP browser flows (OAuth consent, sign-in bridge).
 *
 * Order:
 * 1. Valid host-scoped `an_session`
 * 2. Valid Clerk human browser session (session cookies via `authenticateRequest`)
 * 3. null — caller should redirect to `/sign-in`
 *
 * Does not accept MCP/OAuth AS bearer tokens, script tokens, or Clerk JWT bearer headers.
 */
export async function resolveBrowserAccountId(
  req: BrowserRequest,
  config: AppConfig,
  db: Database,
): Promise<BrowserAccountResolution | null> {
  const cookieKey = config.cookieKeys[0]!;
  const fromSession = decodeSessionCookie(readCookie(cookieHeader(req), SESSION_COOKIE), cookieKey);
  if (fromSession) {
    return { accountId: fromSession, mintedSession: false };
  }

  const fromClerk = await resolveClerkBrowserSession(req, config, db);
  if (fromClerk) {
    return { accountId: fromClerk, mintedSession: true };
  }

  return null;
}
