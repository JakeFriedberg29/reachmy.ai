import { createClerkClient, verifyToken } from "@clerk/backend";
import type { AppConfig } from "../config.js";

export function clerkFrontendApi(publishableKey: string): string {
  const encoded = publishableKey.replace(/^pk_test_|^pk_live_/, "");
  const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8").replace(/\$+$/, "");
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
  });
}
