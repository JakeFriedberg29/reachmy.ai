function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export type AppConfig = {
  port: number;
  publicUrl: string;
  cookieKeys: string[];
  testAccountId: string;
  testPrincipalId: string;
  testHandle: string;
  testDisplayName: string;
};

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? "3000");
  const railwayHost = process.env.RAILWAY_PUBLIC_DOMAIN;
  const publicUrl = (
    process.env.PUBLIC_URL ??
    (railwayHost ? `https://${railwayHost}` : `http://localhost:${port}`)
  ).replace(/\/$/, "");

  const cookieKeys = (process.env.COOKIE_KEYS ?? "phase-minus1-dev-cookie-key-change-me")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  return {
    port,
    publicUrl,
    cookieKeys,
    testAccountId: required(
      "TEST_ACCOUNT_ID",
      "8a2f3c4e-1111-4111-8111-aaaaaaaaaaaa",
    ),
    testPrincipalId: required(
      "TEST_PRINCIPAL_ID",
      "8a2f3c4e-2222-4222-8222-bbbbbbbbbbbb",
    ),
    testHandle: process.env.TEST_HANDLE ?? "jake",
    testDisplayName: process.env.TEST_DISPLAY_NAME ?? "Test Jake",
  };
}

export function hostnameFromUrl(url: string): string {
  return new URL(url).host;
}
