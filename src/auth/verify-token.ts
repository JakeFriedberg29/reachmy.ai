import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/client.js";
import { findConnectionByGrant, getIdentityByAccountId, upsertGrantConnection } from "../domain/identity.js";
import { CONNECTION_REVOKED } from "../domain/connections.js";
import { mcpResource } from "./oidc.js";

export type VerifiedPrincipal = {
  accountId: string;
  principalId: string;
  handle: string;
  displayName: string;
  grantId: string | null;
  clientId: string | null;
  connectionId: string | null;
  onboarding: "complete" | "ONBOARDING_REQUIRED";
};

export function createTokenVerifier(config: AppConfig, db: Database) {
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
      if (!accountId) return null;
      const identity = await getIdentityByAccountId(db, accountId);
      if (!identity.principal_id || identity.onboarding === "ONBOARDING_REQUIRED") {
        return {
          accountId,
          principalId: identity.principal_id ?? "",
          handle: identity.handle ?? "",
          displayName: identity.display_name ?? "",
          grantId: typeof payload.grant_id === "string" ? payload.grant_id : null,
          clientId: typeof payload.client_id === "string" ? payload.client_id : null,
          connectionId: null,
          onboarding: "ONBOARDING_REQUIRED",
        };
      }
      const grantId = typeof payload.grant_id === "string" ? payload.grant_id : null;
      const clientId = typeof payload.client_id === "string" ? payload.client_id : null;
      let connectionId: string | null = null;
      if (grantId) {
        const existing = await findConnectionByGrant(db, identity.principal_id, grantId);
        if (existing?.status === CONNECTION_REVOKED) return null;
        try {
          connectionId = await upsertGrantConnection(db, {
            principalId: identity.principal_id,
            grantId,
            oauthClientId: clientId,
            displayLabel: "MCP",
          });
        } catch {
          return null;
        }
      }
      return {
        accountId,
        principalId: identity.principal_id,
        handle: identity.handle ?? "",
        displayName: identity.display_name ?? "",
        grantId,
        clientId,
        connectionId,
        onboarding: "complete",
      };
    } catch {
      return null;
    }
  };
}
