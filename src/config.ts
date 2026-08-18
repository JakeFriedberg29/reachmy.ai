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

export type AppConfig = {
  port: number;
  publicUrl: string;
  cookieKeys: string[];
  allowedHosts: string[];
  databaseUrl: string;
  clerkPublishableKey: string;
  clerkSecretKey: string;
};

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? "3000");
  const onRailway = Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_ENVIRONMENT_ID ||
      process.env.RAILWAY_PROJECT_ID,
  );
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

  const cookieKeys = (process.env.COOKIE_KEYS ?? "phase-minus1-dev-cookie-key-change-me")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  return {
    port,
    publicUrl,
    cookieKeys,
    allowedHosts: unique([
      hostnameFromUrl(publicUrl),
      railwayHost,
      hostnameOnly(process.env.RAILWAY_PRIVATE_DOMAIN ?? ""),
      "localhost",
      "127.0.0.1",
    ]),
    databaseUrl: required("DATABASE_URL"),
    clerkPublishableKey: required("CLERK_PUBLISHABLE_KEY"),
    clerkSecretKey: required("CLERK_SECRET_KEY"),
  };
}

export function hostnameFromUrl(url: string): string {
  return new URL(url).hostname;
}
