import { createHmac, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";

const COOKIE = "an_session";
const MAX_AGE_S = 60 * 60 * 24 * 7;

export { COOKIE as SESSION_COOKIE };

export function encodeSessionCookie(accountId: string, cookieKey: string): string {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  const mac = sign(accountId, exp, cookieKey);
  return `${accountId}.${exp}.${mac}`;
}

export function decodeSessionCookie(value: string | undefined, cookieKey: string): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [accountId, expRaw, mac] = parts;
  const exp = Number(expRaw);
  if (!accountId || !mac || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const expected = sign(accountId, exp, cookieKey);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return accountId;
}

export function sessionCookieHeader(accountId: string, cookieKey: string, secure: boolean): string {
  const value = encodeSessionCookie(accountId, cookieKey);
  const parts = [
    `${COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE_S}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function appendSessionCookieHeader(
  res: ServerResponse,
  accountId: string,
  config: { cookieKeys: string[]; publicUrl: string },
): void {
  const header = sessionCookieHeader(
    accountId,
    config.cookieKeys[0]!,
    config.publicUrl.startsWith("https"),
  );
  appendSetCookie(res, header);
}

/**
 * Portal cookies: Secure when Portal URL is https, except local MCP issuer on http
 * so Host-header preview against localhost still receives cookies.
 */
export function portalSessionCookieSecure(config: {
  publicUrl: string;
  portalUrl: string;
}): boolean {
  if (config.publicUrl.startsWith("http://")) return false;
  return config.portalUrl.startsWith("https");
}

export function clearSessionCookieHeader(secure: boolean): string {
  const parts = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function appendClearSessionCookieHeader(
  res: ServerResponse,
  config: { publicUrl: string; portalUrl: string },
): void {
  appendSetCookie(res, clearSessionCookieHeader(portalSessionCookieSecure(config)));
}

function appendSetCookie(res: ServerResponse, header: string): void {
  const existing = res.getHeader("set-cookie");
  if (!existing) {
    res.setHeader("set-cookie", header);
  } else if (Array.isArray(existing)) {
    res.setHeader("set-cookie", [...existing, header]);
  } else {
    res.setHeader("set-cookie", [String(existing), header]);
  }
}

function sign(accountId: string, exp: number, cookieKey: string): string {
  return createHmac("sha256", cookieKey).update(`session.${accountId}.${exp}`).digest("base64url");
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}
