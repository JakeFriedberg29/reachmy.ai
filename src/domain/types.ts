export type Actor = {
  accountId: string;
  principalId: string;
  connectionId: string | null;
};

export const HANDLE_RE = /^[a-z0-9_]{3,30}$/;

export function normalizeHandle(raw: string): string {
  return raw.replace(/^@/, "").toLowerCase().trim();
}

export function formatAgentName(handle: string | null | undefined): string | null {
  if (!handle) return null;
  const normalized = normalizeHandle(handle);
  return normalized ? `@${normalized}` : null;
}

export function orderedPair(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

export function now(): Date {
  return new Date();
}
