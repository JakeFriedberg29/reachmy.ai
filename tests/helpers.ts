import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createDb, createSql, type Database } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";
import { provisionTestPrincipal } from "../src/domain/identity.js";
import type { Actor } from "../src/domain/types.js";
import { ensureApiConnection } from "../src/domain/identity.js";

let shared: { db: Database; sql: ReturnType<typeof createSql> } | null = null;

export async function testDb() {
  if (shared) return shared.db;
  const config = loadConfig();
  const sql = createSql(config.databaseUrl);
  const db = createDb(sql);
  await applyMigrations(db, config.databaseUrl);
  shared = { db, sql };
  return db;
}

export function suffix(): string {
  return randomBytes(4).toString("hex");
}

export async function makePrincipal(
  db: Database,
  name: string,
): Promise<{ identity: Awaited<ReturnType<typeof provisionTestPrincipal>>; actor: Actor }> {
  const tag = `${name}_${suffix()}`;
  const identity = await provisionTestPrincipal(db, {
    clerkUserId: `smoke_${tag}`,
    email: `${tag}@example.test`,
    handle: tag.slice(0, 30),
    displayName: name,
  });
  if (!identity.principal_id) throw new Error("expected principal");
  const connectionId = await ensureApiConnection(db, identity.principal_id);
  return {
    identity,
    actor: {
      accountId: identity.account_id,
      principalId: identity.principal_id,
      connectionId,
    },
  };
}
