import { and, eq, or } from "drizzle-orm";
import type { Database, Tx } from "../db/client.js";
import { agentConnections, auditLogs, inboxItems, interactionEvents, oauthModels } from "../db/schema.js";
import { forbidden, notFound } from "./errors.js";
import { getConnectionById, isApiConnection } from "./identity.js";
import type { Actor } from "./types.js";

export const CONNECTION_REVOKED = "revoked";

async function revokeOauthGrant(tx: Tx, grantId: string): Promise<void> {
  await tx
    .delete(oauthModels)
    .where(or(eq(oauthModels.grantId, grantId), and(eq(oauthModels.model, "Grant"), eq(oauthModels.id, grantId))));
}

async function releaseClaimsForConnection(tx: Tx, actor: Actor, connectionId: string): Promise<string[]> {
  const claimed = await tx
    .update(inboxItems)
    .set({
      claimedByAgentConnectionId: null,
      claimedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(inboxItems.claimedByAgentConnectionId, connectionId))
    .returning();

  await tx
    .update(inboxItems)
    .set({
      assigneeAgentConnectionId: null,
      updatedAt: new Date(),
    })
    .where(eq(inboxItems.assigneeAgentConnectionId, connectionId));

  const interactionIds = [...new Set(claimed.map((row) => row.interactionId))];
  for (const interactionId of interactionIds) {
    await tx.insert(interactionEvents).values({
      interactionId,
      type: "CLAIM_RELEASED_CONNECTION_REVOKED",
      actorPrincipalId: actor.principalId,
      agentConnectionId: connectionId,
      payload: { connection_id: connectionId },
    });
  }
  await tx.insert(auditLogs).values({
    actorPrincipalId: actor.principalId,
    agentConnectionId: connectionId,
    action: "CONNECTION_REVOKED",
    entityType: "agent_connection",
    entityId: connectionId,
    payload: { released_claims: interactionIds },
  });
  return interactionIds;
}

export async function revokeAgentConnection(db: Database, actor: Actor, connectionId: string) {
  return db.transaction(async (tx) => {
    const connection = await getConnectionById(tx, connectionId);
    if (!connection) throw notFound("AI connection not found");
    if (connection.principalId !== actor.principalId) throw forbidden("Not your AI connection");
    if (isApiConnection(connection.grantId)) {
      throw forbidden("The API connection cannot be revoked from an AI client");
    }
    if (connection.status === CONNECTION_REVOKED) {
      return { connection, released_interaction_ids: [], idempotent: true };
    }

    const [updated] = await tx
      .update(agentConnections)
      .set({
        status: CONNECTION_REVOKED,
        isPrimary: false,
      })
      .where(eq(agentConnections.id, connection.id))
      .returning();

    const released = await releaseClaimsForConnection(tx, actor, connection.id);
    if (connection.grantId) await revokeOauthGrant(tx, connection.grantId);
    return { connection: updated, released_interaction_ids: released, idempotent: false };
  });
}

export function publicAgentConnection(row: {
  id: string;
  displayLabel: string;
  status: string;
  isPrimary: boolean;
  grantId: string | null;
  oauthClientId: string | null;
  lastAuthorizedAt: Date | null;
}) {
  return {
    agent_connection_id: row.id,
    display_label: row.displayLabel,
    status: row.status,
    is_primary: row.isPrimary,
    last_authorized_at: row.lastAuthorizedAt?.toISOString() ?? null,
  };
}
