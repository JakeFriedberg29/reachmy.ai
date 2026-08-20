function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function hostnameOnly(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.includes("://")) return new URL(trimmed).hostname;
  return new URL(`https://${trimmed}`).hostname;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

/** Known production Neon compute endpoint — local/dev must not write here. */
export const PRODUCTION_NEON_ENDPOINT_ID = "ep-tiny-violet-ayrr8l02";

export function isRailwayRuntime(): boolean {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_ENVIRONMENT_ID ||
      process.env.RAILWAY_PROJECT_ID,
  );
}

/**
 * Fail closed for local/dev/test: refuse DATABASE_URL pointing at production Neon.
 * Railway production is allowed. Emergency override: ALLOW_PRODUCTION_DB=1.
 */
export function assertSafeDatabaseUrl(databaseUrl: string, opts?: { onRailway?: boolean }): void {
  const onRailway = opts?.onRailway ?? isRailwayRuntime();
  if (onRailway) return;
  if (process.env.ALLOW_PRODUCTION_DB === "1") return;

  let hostname = "";
  try {
    hostname = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }

  if (hostname.includes(PRODUCTION_NEON_ENDPOINT_ID)) {
    throw new Error(
      "Refusing to run local development against production database " +
        `(${PRODUCTION_NEON_ENDPOINT_ID}). Use the Neon development branch endpoint, ` +
        "or set ALLOW_PRODUCTION_DB=1 only for an explicit emergency.",
    );
  }
}

export type AppConfig = {
  port: number;
  publicUrl: string;
  portalUrl: string;
  portalHost: string;
  cookieKeys: string[];
  allowedHosts: string[];
  databaseUrl: string;
  clerkPublishableKey: string;
  clerkSecretKey: string;
};

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? "3000");
  const onRailway = isRailwayRuntime();
  const railwayHost = hostnameOnly(process.env.RAILWAY_PUBLIC_DOMAIN ?? "");
  const publicUrl = stripTrailingSlash(
    process.env.PUBLIC_URL ??
      (railwayHost ? `https://${railwayHost}` : `http://localhost:${port}`),
  );

  if (onRailway && new URL(publicUrl).hostname === "localhost") {
    throw new Error(
      "PUBLIC_URL is required on Railway (example: https://reachmyai-production.up.railway.app). Set PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}} in the service variables.",
    );
  }

  const portalHost = hostnameOnly(process.env.PORTAL_HOST ?? "app.reachmy.ai");
  const portalUrl = stripTrailingSlash(process.env.PORTAL_URL ?? `https://${portalHost}`);

  const cookieKeys = (process.env.COOKIE_KEYS ?? "phase-minus1-dev-cookie-key-change-me")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const databaseUrl = required("DATABASE_URL");
  assertSafeDatabaseUrl(databaseUrl, { onRailway });

  return {
    port,
    publicUrl,
    portalUrl,
    portalHost,
    cookieKeys,
    allowedHosts: unique([
      hostnameFromUrl(publicUrl),
      portalHost,
      railwayHost,
      hostnameOnly(process.env.RAILWAY_PRIVATE_DOMAIN ?? ""),
      "localhost",
      "127.0.0.1",
    ]),
    databaseUrl,
    clerkPublishableKey: required("CLERK_PUBLISHABLE_KEY"),
    clerkSecretKey: required("CLERK_SECRET_KEY"),
  };
}

export function hostnameFromUrl(url: string): string {
  return new URL(url).hostname;
}
