import type { Database } from "../db/client.js";
import { revokeAgentConnection } from "./connections.js";
import { getIdentityByAccountId } from "./identity.js";
import {
  listPortalAiConnections,
  type PortalProvider,
} from "./portal-connections.js";
import type { Actor } from "./types.js";

export function parsePortalProvider(raw: string): PortalProvider | null {
  if (raw === "claude" || raw === "chatgpt") return raw;
  return null;
}

/**
 * Revoke all active AI grants for a provider on the authenticated account.
 * Agent Name / principal / other providers are preserved.
 */
export async function disconnectPortalProvider(
  db: Database,
  accountId: string,
  provider: PortalProvider,
): Promise<{ revokedCount: number; alreadyDisconnected: boolean }> {
  const identity = await getIdentityByAccountId(db, accountId);
  if (!identity.principal_id) {
    return { revokedCount: 0, alreadyDisconnected: true };
  }

  const view = await listPortalAiConnections(db, accountId);
  const connectionIds = view.connectionIdsByProvider[provider];
  if (connectionIds.length === 0) {
    return { revokedCount: 0, alreadyDisconnected: true };
  }

  const actor: Actor = {
    accountId,
    principalId: identity.principal_id,
    connectionId: null,
  };

  for (const connectionId of connectionIds) {
    await revokeAgentConnection(db, actor, connectionId);
  }

  return { revokedCount: connectionIds.length, alreadyDisconnected: false };
}
