import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/client.js";
import {
  ensureProvisionalPrincipal,
  findConnectionByGrant,
  getIdentityByAccountId,
  upsertGrantConnection,
} from "../domain/identity.js";
import { CONNECTION_REVOKED } from "../domain/connections.js";
import { DomainError } from "../domain/errors.js";
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

/** Report-only. Never returned to the client; MCP still answers 401 invalid_token. */
export type TokenVerifyFailureReason = "invalid_token" | "revoked_connection" | "connection_conflict";

export type TokenVerification =
  | { ok: true; principal: VerifiedPrincipal }
  | {
      ok: false;
      reason: TokenVerifyFailureReason;
      clientId: string | null;
      grantId: string | null;
    };

function failed(
  reason: TokenVerifyFailureReason,
  clientId: string | null = null,
  grantId: string | null = null,
): TokenVerification {
  return { ok: false, reason, clientId, grantId };
}

export function createTokenVerifier(config: AppConfig, db: Database) {
  const jwks = createRemoteJWKSet(new URL(`${config.publicUrl}/jwks`));
  const resource = mcpResource(config.publicUrl);

  return async function verifyAccessToken(
    authorization: string | undefined,
  ): Promise<TokenVerification> {
    if (!authorization?.startsWith("Bearer ")) return failed("invalid_token");
    const token = authorization.slice("Bearer ".length).trim();
    if (!token) return failed("invalid_token");

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.publicUrl,
        audience: resource,
      });
      const accountId = typeof payload.sub === "string" ? payload.sub : null;
      if (!accountId) return failed("invalid_token");
      let identity = await getIdentityByAccountId(db, accountId);
      if (!identity.principal_id) {
        await ensureProvisionalPrincipal(db, accountId);
        identity = await getIdentityByAccountId(db, accountId);
      }
      const grantId = typeof payload.grant_id === "string" ? payload.grant_id : null;
      const clientId = typeof payload.client_id === "string" ? payload.client_id : null;
      let connectionId: string | null = null;
      if (grantId && identity.principal_id) {
        const existing = await findConnectionByGrant(db, identity.principal_id, grantId);
        if (existing?.status === CONNECTION_REVOKED) {
          return failed("revoked_connection", clientId, grantId);
        }
        try {
          connectionId = await upsertGrantConnection(db, {
            principalId: identity.principal_id,
            grantId,
            oauthClientId: clientId,
            displayLabel: "MCP",
          });
        } catch (error) {
          if (error instanceof DomainError && error.code === "unauthorized") {
            return failed("revoked_connection", clientId, grantId);
          }
          return failed("connection_conflict", clientId, grantId);
        }
      }
      return {
        ok: true,
        principal: {
          accountId,
          principalId: identity.principal_id ?? "",
          handle: identity.handle ?? "",
          displayName: identity.display_name ?? "",
          grantId,
          clientId,
          connectionId,
          onboarding: identity.onboarding,
        },
      };
    } catch {
      return failed("invalid_token");
    }
  };
}
