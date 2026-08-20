import { createClerkClient, verifyToken } from "@clerk/backend";
import type { AppConfig } from "../config.js";
import { hostnameFromUrl } from "../config.js";

export function clerkFrontendApi(publishableKey: string): string {
  const encoded = publishableKey.replace(/^pk_test_|^pk_live_/, "");
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8").replace(/\$+$/, "");
}

function isLocalDevHost(config: AppConfig): boolean {
  const mcpHost = hostnameFromUrl(config.publicUrl);
  return mcpHost === "localhost" || mcpHost === "127.0.0.1" || config.portalHost === "localhost";
}

/** Clerk `authorizedParties` — production Portal + MCP origins; localhost added in dev only. */
export function clerkAuthorizedParties(config: AppConfig): string[] {
  const parties = [config.portalUrl, config.publicUrl];
  if (isLocalDevHost(config)) {
    parties.push(`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`);
  }
  return [...new Set(parties)];
}

export function createClerk(config: AppConfig) {
  return createClerkClient({
    secretKey: config.clerkSecretKey,
    publishableKey: config.clerkPublishableKey,
  });
}

export async function verifyClerkJwt(config: AppConfig, token: string) {
  return verifyToken(token, {
    secretKey: config.clerkSecretKey,
    authorizedParties: clerkAuthorizedParties(config),
  });
}
