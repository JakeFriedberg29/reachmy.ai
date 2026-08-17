import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppConfig } from "../config.js";
import { mcpResource } from "./oidc.js";

export type VerifiedPrincipal = {
  accountId: string;
  principalId: string;
  handle: string;
  displayName: string;
};

export function createTokenVerifier(config: AppConfig) {
  const jwks = createRemoteJWKSet(new URL(`${config.publicUrl}/jwks`));
  const resource = mcpResource(config.publicUrl);

  return async function verifyAccessToken(
    authorization: string | undefined,
  ): Promise<VerifiedPrincipal | null> {
    if (!authorization?.startsWith("Bearer ")) return null;
    const token = authorization.slice("Bearer ".length).trim();
    if (!token) return null;

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.publicUrl,
        audience: resource,
      });
      const accountId = typeof payload.sub === "string" ? payload.sub : null;
      if (!accountId || accountId !== config.testAccountId) return null;
      return {
        accountId,
        principalId: config.testPrincipalId,
        handle: config.testHandle,
        displayName: config.testDisplayName,
      };
    } catch {
      return null;
    }
  };
}
