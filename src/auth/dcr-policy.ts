import type { ClientMetadata } from "oidc-provider";

/**
 * Dynamic Client Registration stays open: Claude and ChatGPT both discover ReachMy through
 * `POST /reg` (decision 68). Registration therefore establishes client *identity* only —
 * authorization is the explicit consent screen added in Slice 4 (decision 69).
 *
 * Nothing in this module may branch on provider, `client_name`, or redirect hostname. The rules
 * below are uniform for every client (decision 70 / locked principle 13).
 */

export const DCR_LIMITS = {
  /** Generous next to real clients: Claude and ChatGPT each register a single redirect URI. */
  maxRedirectUris: 10,
  maxClientNameLength: 120,
  maxRedirectUriLength: 2048,
} as const;

/** Hosts that are only reachable from the machine itself, so plain http carries no exposure. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Gaps left by `oidc-provider`'s own client schema, and only those.
 *
 * It already rejects fragments, requires at least one redirect URI when response types are
 * present, and rejects non-web schemes for `web` clients and dangerous schemes for `native`
 * clients. What it does not do is require transport security: for a code-flow `web` client —
 * exactly the shape Claude and ChatGPT register — plain `http:` is accepted on any hostname.
 *
 * Returns `null` when the metadata is acceptable, otherwise the RFC 7591 error code and a
 * human-readable reason. Values with the wrong type are passed through untouched; the provider's
 * own schema reports those.
 */
export type DcrPolicyViolation = {
  error: "invalid_client_metadata" | "invalid_redirect_uri";
  description: string;
};

export function validateClientMetadata(
  metadata: Partial<ClientMetadata>,
): DcrPolicyViolation | null {
  const clientName = metadata.client_name;
  if (typeof clientName === "string" && clientName.length > DCR_LIMITS.maxClientNameLength) {
    return {
      error: "invalid_client_metadata",
      description: `client_name must be at most ${DCR_LIMITS.maxClientNameLength} characters`,
    };
  }

  const redirectUris = metadata.redirect_uris;
  if (!Array.isArray(redirectUris)) return null;

  if (redirectUris.length > DCR_LIMITS.maxRedirectUris) {
    return {
      error: "invalid_redirect_uri",
      description: `redirect_uris must contain at most ${DCR_LIMITS.maxRedirectUris} entries`,
    };
  }

  for (const uri of redirectUris) {
    if (typeof uri !== "string") continue;
    if (uri.length > DCR_LIMITS.maxRedirectUriLength) {
      return {
        error: "invalid_redirect_uri",
        description: `redirect_uris entries must be at most ${DCR_LIMITS.maxRedirectUriLength} characters`,
      };
    }
    if (uri.includes("*")) {
      return { error: "invalid_redirect_uri", description: "redirect_uris must not contain wildcards" };
    }
    const parsed = URL.parse(uri);
    if (!parsed) continue;
    if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
      return {
        error: "invalid_redirect_uri",
        description: "redirect_uris using http may only target loopback hosts; use https",
      };
    }
  }

  return null;
}

/**
 * Fixed-window per-key counter. One Railway process serves all traffic, so an in-memory window
 * is the whole control — no new infrastructure (plan §4 control 2).
 */
export type RateLimiter = {
  /** True when the request is within budget. Consumes one unit when it returns true. */
  allow(key: string, now?: number): boolean;
};

export const DCR_RATE_LIMIT = {
  limit: 20,
  windowMs: 10 * 60 * 1000,
} as const;

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
}): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();

  return {
    allow(key, now = Date.now()) {
      for (const [existing, window] of windows) {
        if (window.resetAt <= now) windows.delete(existing);
      }
      const current = windows.get(key);
      if (!current || current.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + options.windowMs });
        return true;
      }
      if (current.count >= options.limit) return false;
      current.count += 1;
      return true;
    },
  };
}

export const DEV_CLI_CLIENT_ID = "phase-minus1-cli";

/**
 * The Phase -1 CLI client exists to drive `/dev/callback` during local spikes. It has no secret
 * and never had a production purpose, so production ships without it (plan §4 control 5).
 */
export function devStaticClients(
  publicUrl: string,
  production: boolean,
  scope: string,
): ClientMetadata[] {
  if (production) return [];
  return [
    {
      client_id: DEV_CLI_CLIENT_ID,
      client_secret: "phase-minus1-cli-secret",
      token_endpoint_auth_method: "none",
      redirect_uris: [`${publicUrl}/dev/callback`],
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      scope,
    },
  ];
}
