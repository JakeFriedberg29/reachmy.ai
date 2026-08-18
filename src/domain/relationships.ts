import { and, eq, ne, or } from "drizzle-orm";
import type { Database, Tx } from "../db/client.js";
import { blocks, handles, relationshipPermissions, relationships } from "../db/schema.js";
import { findPrincipalByHandle } from "./identity.js";
import { forbidden, invalidState, notFound } from "./errors.js";
import { formatAgentName, orderedPair } from "./types.js";
import type { Actor } from "./types.js";

const DEFAULT_PERMS = {
  messaging: true,
  scheduling: true,
  negotiation: false,
  purchases: "ask",
  financialInfo: "deny",
};

export async function findRelationship(db: Database | Tx, a: string, b: string) {
  const { low, high } = orderedPair(a, b);
  const [row] = await db
    .select()
    .from(relationships)
    .where(and(eq(relationships.principalLowId, low), eq(relationships.principalHighId, high)))
    .limit(1);
  return row ?? null;
}

export async function requireActiveRelationship(db: Database | Tx, a: string, b: string) {
  const row = await findRelationship(db, a, b);
  if (!row || row.status !== "active") throw forbidden("No active relationship");
  return row;
}

export async function isBlocked(db: Database | Tx, a: string, b: string) {
  const [row] = await db
    .select()
    .from(blocks)
    .where(
      and(
        eq(blocks.blockerPrincipalId, a),
        eq(blocks.blockedPrincipalId, b),
      ),
    )
    .limit(1);
  const [other] = await db
    .select()
    .from(blocks)
    .where(
      and(
        eq(blocks.blockerPrincipalId, b),
        eq(blocks.blockedPrincipalId, a),
      ),
    )
    .limit(1);
  return Boolean(row || other);
}

export async function assertNotBlocked(db: Database | Tx, a: string, b: string) {
  if (await isBlocked(db, a, b)) throw forbidden("Blocked");
}

export async function getDirectionalPermission(
  db: Database | Tx,
  relationshipId: string,
  grantorPrincipalId: string,
  granteePrincipalId: string,
) {
  const [row] = await db
    .select()
    .from(relationshipPermissions)
    .where(
      and(
        eq(relationshipPermissions.relationshipId, relationshipId),
        eq(relationshipPermissions.grantorPrincipalId, grantorPrincipalId),
        eq(relationshipPermissions.granteePrincipalId, granteePrincipalId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function requirePermission(
  db: Database | Tx,
  input: {
    grantorPrincipalId: string;
    granteePrincipalId: string;
    capability: "messaging" | "scheduling" | "negotiation";
  },
) {
  if (input.grantorPrincipalId === input.granteePrincipalId) throw forbidden("Invalid permission subject");
  await assertNotBlocked(db, input.grantorPrincipalId, input.granteePrincipalId);
  const rel = await requireActiveRelationship(db, input.grantorPrincipalId, input.granteePrincipalId);
  const perms = await getDirectionalPermission(
    db,
    rel.id,
    input.grantorPrincipalId,
    input.granteePrincipalId,
  );
  if (!perms || !perms[input.capability]) {
    throw forbidden(`Missing ${input.capability} permission`);
  }
  return { relationship: rel, permissions: perms };
}

export async function createRelationshipWithDefaults(
  db: Database | Tx,
  a: string,
  b: string,
) {
  if (a === b) throw forbidden("Cannot relate a principal to itself");
  const { low, high } = orderedPair(a, b);
  const existing = await findRelationship(db, a, b);
  if (existing) {
    if (existing.status === "active") return existing;
    const [revived] = await db
      .update(relationships)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(relationships.id, existing.id))
      .returning();
    return revived;
  }
  const [rel] = await db
    .insert(relationships)
    .values({ principalLowId: low, principalHighId: high, status: "active" })
    .returning();
  await db.insert(relationshipPermissions).values([
    {
      relationshipId: rel.id,
      grantorPrincipalId: a,
      granteePrincipalId: b,
      ...DEFAULT_PERMS,
    },
    {
      relationshipId: rel.id,
      grantorPrincipalId: b,
      granteePrincipalId: a,
      ...DEFAULT_PERMS,
    },
  ]);
  return rel;
}

export async function setPermissionFlag(
  db: Database,
  input: {
    actorPrincipalId: string;
    otherPrincipalId: string;
    capability: "messaging" | "scheduling" | "negotiation";
    value: boolean;
  },
) {
  const rel = await requireActiveRelationship(db, input.actorPrincipalId, input.otherPrincipalId);
  const [updated] = await db
    .update(relationshipPermissions)
    .set({ [input.capability]: input.value, updatedAt: new Date() })
    .where(
      and(
        eq(relationshipPermissions.relationshipId, rel.id),
        eq(relationshipPermissions.grantorPrincipalId, input.actorPrincipalId),
        eq(relationshipPermissions.granteePrincipalId, input.otherPrincipalId),
        ne(relationshipPermissions.grantorPrincipalId, relationshipPermissions.granteePrincipalId),
      ),
    )
    .returning();
  if (!updated) throw notFound("Permissions row missing");
  return updated;
}

function publicFlags(row: {
  messaging: boolean;
  scheduling: boolean;
  negotiation: boolean;
} | null) {
  return {
    messaging: row?.messaging ?? false,
    scheduling: row?.scheduling ?? false,
    negotiation: row?.negotiation ?? false,
  };
}

export async function listRelationshipsFor(db: Database | Tx, principalId: string) {
  const rows = await db
    .select()
    .from(relationships)
    .where(
      and(
        or(eq(relationships.principalLowId, principalId), eq(relationships.principalHighId, principalId)),
        eq(relationships.status, "active"),
      ),
    );
  const result = [];
  for (const row of rows) {
    const otherId = row.principalLowId === principalId ? row.principalHighId : row.principalLowId;
    const [handle] = await db.select().from(handles).where(eq(handles.principalId, otherId)).limit(1);
    result.push({
      relationship_id: row.id,
      other_principal_id: otherId,
      agent_name: formatAgentName(handle?.handle),
      status: row.status,
    });
  }
  return result;
}

export async function getRelationshipPermissionsView(db: Database | Tx, actor: Actor, otherHandle: string) {
  const { principal: other, handle } = await findPrincipalByHandle(db, otherHandle);
  const rel = await requireActiveRelationship(db, actor.principalId, other.id);
  const grantedToThem = await getDirectionalPermission(db, rel.id, actor.principalId, other.id);
  const grantedToMe = await getDirectionalPermission(db, rel.id, other.id, actor.principalId);
  return {
    relationship_id: rel.id,
    other_agent_name: formatAgentName(handle.handle),
    granted_to_them: publicFlags(grantedToThem),
    granted_to_me: publicFlags(grantedToMe),
  };
}

export async function setRelationshipPermissions(
  db: Database,
  actor: Actor,
  input: {
    otherHandle: string;
    messaging?: boolean;
    scheduling?: boolean;
    negotiation?: boolean;
  },
) {
  const { principal: other, handle } = await findPrincipalByHandle(db, input.otherHandle);
  const flags: Array<["messaging" | "scheduling" | "negotiation", boolean]> = [];
  if (typeof input.messaging === "boolean") flags.push(["messaging", input.messaging]);
  if (typeof input.scheduling === "boolean") flags.push(["scheduling", input.scheduling]);
  if (typeof input.negotiation === "boolean") flags.push(["negotiation", input.negotiation]);
  if (!flags.length) throw invalidState("Provide at least one of messaging, scheduling, or negotiation");
  for (const [capability, value] of flags) {
    await setPermissionFlag(db, {
      actorPrincipalId: actor.principalId,
      otherPrincipalId: other.id,
      capability,
      value,
    });
  }
  return getRelationshipPermissionsView(db, actor, handle.handle);
}
