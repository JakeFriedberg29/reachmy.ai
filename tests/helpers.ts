import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createDb, createSql, type Database } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";
import { provisionTestPrincipal, upsertGrantConnection } from "../src/domain/identity.js";
import type { Actor } from "../src/domain/types.js";
import { ensureApiConnection } from "../src/domain/identity.js";
import type { VerifiedPrincipal } from "../src/auth/verify-token.js";

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

export async function makeGrantPrincipal(
  db: Database,
  name: string,
  label = "MCP",
): Promise<{
  identity: Awaited<ReturnType<typeof provisionTestPrincipal>>;
  actor: Actor;
  principal: VerifiedPrincipal;
}> {
  const { identity, actor: apiActor } = await makePrincipal(db, name);
  const grantId = `${label}:${identity.principal_id}:${suffix()}`;
  const connectionId = await upsertGrantConnection(db, {
    principalId: identity.principal_id!,
    grantId,
    oauthClientId: grantId,
    displayLabel: label,
  });
  void apiActor;
  return {
    identity,
    actor: {
      accountId: identity.account_id,
      principalId: identity.principal_id!,
      connectionId,
    },
    principal: {
      accountId: identity.account_id,
      principalId: identity.principal_id!,
      handle: identity.handle ?? "",
      displayName: identity.display_name ?? "",
      grantId,
      clientId: grantId,
      connectionId,
      onboarding: "complete",
    },
  };
}
