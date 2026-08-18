import { and, eq, ne } from "drizzle-orm";
import type { Database, Tx } from "../db/client.js";
import { blocks, relationshipPermissions, relationships } from "../db/schema.js";
import { forbidden, notFound } from "./errors.js";
import { orderedPair } from "./types.js";

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
