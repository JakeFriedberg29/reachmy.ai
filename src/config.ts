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

/** Development-only fallback when COOKIE_KEYS is unset locally. Never valid in production. */
export const DEV_COOKIE_KEY_FALLBACK = "phase-minus1-dev-cookie-key-change-me";

/** Placeholder from .env.example — never valid as a signing secret. */
export const EXAMPLE_COOKIE_KEY_PLACEHOLDER = "change-me-to-a-long-random-string";

export const MIN_COOKIE_KEY_LENGTH = 32;

let warnedDevCookieKey = false;

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

/**
 * Production when running on Railway or when PUBLIC_URL is HTTPS on a non-localhost host.
 */
export function isProductionRuntime(
  publicUrl: string,
  opts?: { onRailway?: boolean },
): boolean {
  const onRailway = opts?.onRailway ?? isRailwayRuntime();
  if (onRailway) return true;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host !== "localhost" && host !== "127.0.0.1";
  } catch {
    return false;
  }
}

export function parseCookieKeys(raw: string | undefined, fallback: string): string[] {
  const source = raw?.trim() ? raw : fallback;
  return source
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

export function isUnsafeCookieKey(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) return true;
  if (trimmed.length < MIN_COOKIE_KEY_LENGTH) return true;
  if (trimmed === DEV_COOKIE_KEY_FALLBACK) return true;
  if (trimmed === EXAMPLE_COOKIE_KEY_PLACEHOLDER) return true;
  return false;
}

/**
 * Fail closed in production: refuse default, missing, or weak COOKIE_KEYS.
 * Local development may use the named dev fallback with a one-time warning.
 */
export function assertSafeCookieKeys(
  cookieKeys: string[],
  opts: { production: boolean; envProvided: boolean },
): void {
  const primary = cookieKeys[0] ?? "";
  if (!opts.production) {
    if (isUnsafeCookieKey(primary) && !warnedDevCookieKey) {
      warnedDevCookieKey = true;
      console.warn(
        JSON.stringify({
          msg: "cookie_keys_dev_fallback",
          warning:
            "COOKIE_KEYS is unset or uses a development placeholder. Set a long random COOKIE_KEYS in .env for local testing.",
        }),
      );
    }
    return;
  }

  if (!opts.envProvided) {
    throw new Error(
      "COOKIE_KEYS is required in production. Set a long random string (32+ characters) in Railway service variables.",
    );
  }
  if (cookieKeys.length === 0) {
    throw new Error("COOKIE_KEYS must contain at least one signing key in production.");
  }
  if (isUnsafeCookieKey(primary)) {
    throw new Error(
      "COOKIE_KEYS is missing, too short, or uses a known development default. " +
        `Set a unique secret of at least ${MIN_COOKIE_KEY_LENGTH} characters in production.`,
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

  const cookieKeysEnv = process.env.COOKIE_KEYS;
  const cookieKeysEnvProvided = Boolean(cookieKeysEnv?.trim());
  const production = isProductionRuntime(publicUrl, { onRailway });
  const cookieKeys = parseCookieKeys(cookieKeysEnv, DEV_COOKIE_KEY_FALLBACK);
  assertSafeCookieKeys(cookieKeys, { production, envProvided: cookieKeysEnvProvided });

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
