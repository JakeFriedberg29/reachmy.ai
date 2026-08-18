import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "anp1";

export function mintScriptToken(accountId: string, cookieKey: string, ttlSeconds = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const mac = sign(accountId, exp, cookieKey);
  return `${PREFIX}.${accountId}.${exp}.${mac}`;
}

export function verifyScriptToken(token: string, cookieKey: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, accountId, expRaw, mac] = parts;
  const exp = Number(expRaw);
  if (!accountId || !mac || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const expected = sign(accountId, exp, cookieKey);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return accountId;
}

function sign(accountId: string, exp: number, cookieKey: string): string {
  return createHmac("sha256", cookieKey).update(`${accountId}.${exp}`).digest("base64url");
}
