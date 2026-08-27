import { createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.js";

/** Stateless CSRF token bound to the signed-in Portal account. */
export function mintPortalCsrfToken(accountId: string, cookieKey: string): string {
  return createHmac("sha256", cookieKey).update(`portal-csrf.v1.${accountId}`).digest("base64url");
}

export function verifyPortalCsrfToken(
  accountId: string,
  token: string | null | undefined,
  cookieKey: string,
): boolean {
  if (!token) return false;
  const expected = mintPortalCsrfToken(accountId, cookieKey);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Portal mutation Origin must match PORTAL_URL.
 * Local http issuer also allows localhost / 127.0.0.1 origins.
 */
export function isAllowedPortalMutationOrigin(
  origin: string | undefined,
  config: AppConfig,
): boolean {
  if (!origin) return false;
  if (origin === config.portalUrl) return true;
  if (!config.publicUrl.startsWith("http://")) return false;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}
