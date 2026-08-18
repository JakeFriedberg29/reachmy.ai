import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { invites } from "../db/schema.js";
import { conflict, DomainError, notFound } from "./errors.js";
import { createRelationshipWithDefaults } from "./relationships.js";
import type { Actor } from "./types.js";

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createInvite(db: Database, actor: Actor) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashInviteToken(token);
  const [invite] = await db
    .insert(invites)
    .values({
      tokenHash,
      inviterPrincipalId: actor.principalId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    })
    .returning();
  return { invite, token };
}

export async function acceptInvite(db: Database, actor: Actor, token: string) {
  const tokenHash = hashInviteToken(token);
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(invites)
      .set({
        consumedAt: new Date(),
        consumedByPrincipalId: actor.principalId,
      })
      .where(
        and(
          eq(invites.tokenHash, tokenHash),
          isNull(invites.consumedAt),
          sql`${invites.expiresAt} > now()`,
        ),
      )
      .returning();

    if (!claimed) {
      const [existing] = await tx.select().from(invites).where(eq(invites.tokenHash, tokenHash)).limit(1);
      if (!existing) throw notFound("Invite not found");
      if (existing.consumedAt) throw conflict("Invite already used");
      throw new DomainError("invite_expired", "Invite has expired", 410);
    }
    if (claimed.inviterPrincipalId === actor.principalId) {
      throw conflict("Cannot accept your own invite");
    }
    const relationship = await createRelationshipWithDefaults(
      tx,
      claimed.inviterPrincipalId,
      actor.principalId,
    );
    return { invite: claimed, relationship };
  });
}
