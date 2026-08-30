import { and, eq, lte, sql } from "drizzle-orm";
import type { Adapter, AdapterPayload } from "oidc-provider";
import type { Database } from "../db/client.js";
import { oauthModels } from "../db/schema.js";

type Payload = AdapterPayload & Record<string, unknown>;

function expiresAtFrom(expiresIn?: number): Date | null {
  if (!expiresIn) return null;
  return new Date(Date.now() + expiresIn * 1000);
}

export function createDrizzleAdapter(db: Database) {
  return class DrizzleAdapter implements Adapter {
    constructor(public model: string) {}

    async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
      const expiresAt = expiresAtFrom(expiresIn);
      const grantId = typeof payload.grantId === "string" ? payload.grantId : null;
      const uid = typeof payload.uid === "string" ? payload.uid : null;
      const userCode = typeof payload.userCode === "string" ? payload.userCode : null;
      await db
        .insert(oauthModels)
        .values({
          model: this.model,
          id,
          payload,
          expiresAt,
          grantId,
          uid,
          userCode,
          consumedAt: typeof payload.consumed === "number" ? payload.consumed : null,
        })
        .onConflictDoUpdate({
          target: [oauthModels.model, oauthModels.id],
          set: {
            payload,
            expiresAt,
            grantId,
            uid,
            userCode,
          },
        });
    }

    async find(id: string): Promise<Payload | undefined> {
      const [row] = await db
        .select()
        .from(oauthModels)
        .where(and(eq(oauthModels.model, this.model), eq(oauthModels.id, id)))
        .limit(1);
      return this.hydrate(row);
    }

    async findByUid(uid: string): Promise<Payload | undefined> {
      const [row] = await db
        .select()
        .from(oauthModels)
        .where(and(eq(oauthModels.model, this.model), eq(oauthModels.uid, uid)))
        .limit(1);
      return this.hydrate(row);
    }

    async findByUserCode(userCode: string): Promise<Payload | undefined> {
      const [row] = await db
        .select()
        .from(oauthModels)
        .where(and(eq(oauthModels.model, this.model), eq(oauthModels.userCode, userCode)))
        .limit(1);
      return this.hydrate(row);
    }

    async consume(id: string): Promise<void> {
      const consumed = Math.floor(Date.now() / 1000);
      const current = await this.find(id);
      if (!current) return;
      await db
        .update(oauthModels)
        .set({
          consumedAt: consumed,
          payload: { ...current, consumed },
        })
        .where(and(eq(oauthModels.model, this.model), eq(oauthModels.id, id)));
    }

    async destroy(id: string): Promise<void> {
      await db
        .delete(oauthModels)
        .where(and(eq(oauthModels.model, this.model), eq(oauthModels.id, id)));
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await db.delete(oauthModels).where(eq(oauthModels.grantId, grantId));
    }

    private async hydrate(
      row:
        | {
            payload: Record<string, unknown>;
            expiresAt: Date | null;
            consumedAt: number | null;
            id: string;
          }
        | undefined,
    ): Promise<Payload | undefined> {
      if (!row) return undefined;
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
        await this.destroy(row.id);
        return undefined;
      }
      const payload = { ...(row.payload as Payload) };
      if (row.consumedAt) payload.consumed = row.consumedAt;
      return payload;
    }
  };
}

export async function purgeExpiredOauthModels(db: Database): Promise<void> {
  await db.delete(oauthModels).where(and(sql`${oauthModels.expiresAt} is not null`, lte(oauthModels.expiresAt, new Date())));
}
