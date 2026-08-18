import { createHmac, timingSafeEqual } from "node:crypto";

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
