import { and, eq, or } from "drizzle-orm";
import type { Database, Tx } from "../db/client.js";
import {
  accounts,
  agentConnections,
  handles,
  principals,
} from "../db/schema.js";
import { conflict, DomainError, notFound } from "./errors.js";
import type { Actor } from "./types.js";
import { HANDLE_RE } from "./types.js";

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let i = 0; i < 6 && current && typeof current === "object"; i++) {
    const candidate = current as { code?: string; message?: string; cause?: unknown };
    if (candidate.code === "23505") return true;
    if (typeof candidate.message === "string" && candidate.message.includes("duplicate key")) return true;
    current = candidate.cause;
  }
  return false;
}

export type IdentityView = {
  account_id: string;
  principal_id: string | null;
  clerk_user_id: string;
  handle: string | null;
  display_name: string | null;
  onboarding: "complete" | "ONBOARDING_REQUIRED";
};

async function identityFromAccount(
  db: Database | Tx,
  accountId: string,
): Promise<IdentityView> {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account) throw notFound("Account not found");
  const [principal] = await db
    .select()
    .from(principals)
    .where(eq(principals.accountId, account.id))
    .limit(1);
  if (!principal) {
    return {
      account_id: account.id,
      principal_id: null,
      clerk_user_id: account.clerkUserId,
      handle: null,
      display_name: null,
      onboarding: "ONBOARDING_REQUIRED",
    };
  }
  const [handle] = await db
    .select()
    .from(handles)
    .where(eq(handles.principalId, principal.id))
    .limit(1);
  return {
    account_id: account.id,
    principal_id: principal.id,
    clerk_user_id: account.clerkUserId,
    handle: handle?.handle ?? null,
    display_name: principal.displayName,
    onboarding: handle ? "complete" : "ONBOARDING_REQUIRED",
  };
}

export async function upsertAccountByClerkUser(
  db: Database | Tx,
  input: { clerkUserId: string; email?: string | null },
) {
  const [existing] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.clerkUserId, input.clerkUserId))
    .limit(1);
  if (existing) {
    if (input.email && existing.email !== input.email) {
      await db
        .update(accounts)
        .set({ email: input.email, updatedAt: new Date() })
        .where(eq(accounts.id, existing.id));
    }
    return identityFromAccount(db, existing.id);
  }
  const [created] = await db
    .insert(accounts)
    .values({ clerkUserId: input.clerkUserId, email: input.email ?? null })
    .returning();
  return identityFromAccount(db, created.id);
}

export async function getIdentityByAccountId(db: Database | Tx, accountId: string) {
  return identityFromAccount(db, accountId);
}

export async function getIdentityByPrincipalId(db: Database | Tx, principalId: string) {
  const [principal] = await db.select().from(principals).where(eq(principals.id, principalId)).limit(1);
  if (!principal) throw notFound("Principal not found");
  return identityFromAccount(db, principal.accountId);
}

export async function requireActorPrincipal(db: Database | Tx, accountId: string): Promise<Actor> {
  const identity = await identityFromAccount(db, accountId);
  if (!identity.principal_id) {
    throw new DomainError("onboarding_required", "Create an identity before using the network", 409);
  }
  const connectionId = await ensureApiConnection(db, identity.principal_id);
  return { accountId, principalId: identity.principal_id, connectionId };
}

export async function findPrincipalByHandle(db: Database | Tx, rawHandle: string) {
  const handle = rawHandle.replace(/^@/, "").toLowerCase();
  const [row] = await db.select().from(handles).where(eq(handles.handle, handle)).limit(1);
  if (!row) throw notFound(`Unknown handle @${handle}`);
  const [principal] = await db.select().from(principals).where(eq(principals.id, row.principalId)).limit(1);
  if (!principal) throw notFound("Principal not found");
  return { principal, handle: row };
}

export async function createIdentity(
  db: Database,
  accountId: string,
  input: { handle: string; displayName: string },
) {
  const handle = input.handle.replace(/^@/, "").toLowerCase();
  if (!HANDLE_RE.test(handle)) {
    throw new DomainError("invalid_handle", "Handle must match ^[a-z0-9_]{3,30}$", 400);
  }
  const displayName = input.displayName.trim();
  if (!displayName) throw new DomainError("invalid_display_name", "display_name is required", 400);

  return db.transaction(async (tx) => {
    const identity = await identityFromAccount(tx, accountId);
    if (identity.principal_id) {
      throw conflict("Identity already exists for this account");
    }
    try {
      const [principal] = await tx
        .insert(principals)
        .values({ accountId, displayName, status: "active" })
        .returning();
      await tx.insert(handles).values({ principalId: principal.id, handle });
      await ensureApiConnection(tx, principal.id);
      return identityFromAccount(tx, accountId);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("Handle already taken");
      }
      throw error;
    }
  });
}

export async function provisionTestPrincipal(
  db: Database,
  input: { clerkUserId: string; email?: string; handle: string; displayName: string },
) {
  const identity = await upsertAccountByClerkUser(db, {
    clerkUserId: input.clerkUserId,
    email: input.email ?? null,
  });
  if (identity.principal_id) {
    await ensureApiConnection(db, identity.principal_id);
    return getIdentityByAccountId(db, identity.account_id);
  }
  return createIdentity(db, identity.account_id, {
    handle: input.handle,
    displayName: input.displayName,
  });
}

export async function ensureApiConnection(db: Database | Tx, principalId: string): Promise<string> {
  const grantId = `api:${principalId}`;
  const [existing] = await db
    .select()
    .from(agentConnections)
    .where(
      and(eq(agentConnections.principalId, principalId), eq(agentConnections.grantId, grantId)),
    )
    .limit(1);
  if (existing) return existing.id;

  const [primary] = await db
    .select()
    .from(agentConnections)
    .where(
      and(
        eq(agentConnections.principalId, principalId),
        eq(agentConnections.status, "connected"),
        eq(agentConnections.isPrimary, true),
      ),
    )
    .limit(1);

  const [created] = await db
    .insert(agentConnections)
    .values({
      principalId,
      grantId,
      oauthClientId: grantId,
      provider: null,
      displayLabel: "API",
      status: "connected",
      isPrimary: !primary,
      capabilities: { inbox_available: true, push_reachable: false },
      lastAuthorizedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created.id;

  const [retry] = await db
    .select()
    .from(agentConnections)
    .where(or(eq(agentConnections.grantId, grantId), eq(agentConnections.oauthClientId, grantId)))
    .limit(1);
  if (!retry) throw new DomainError("connection_failed", "Could not create agent connection", 500);
  return retry.id;
}

export async function upsertGrantConnection(
  db: Database | Tx,
  input: {
    principalId: string;
    grantId: string;
    oauthClientId?: string | null;
    displayLabel?: string;
  },
) {
  const [byGrant] = await db
    .select()
    .from(agentConnections)
    .where(
      and(eq(agentConnections.principalId, input.principalId), eq(agentConnections.grantId, input.grantId)),
    )
    .limit(1);
  if (byGrant) {
    await db
      .update(agentConnections)
      .set({
        status: "connected",
        oauthClientId: input.oauthClientId ?? byGrant.oauthClientId,
        lastAuthorizedAt: new Date(),
      })
      .where(eq(agentConnections.id, byGrant.id));
    return byGrant.id;
  }

  const [primary] = await db
    .select()
    .from(agentConnections)
    .where(
      and(
        eq(agentConnections.principalId, input.principalId),
        eq(agentConnections.status, "connected"),
        eq(agentConnections.isPrimary, true),
      ),
    )
    .limit(1);

  const [created] = await db
    .insert(agentConnections)
    .values({
      principalId: input.principalId,
      grantId: input.grantId,
      oauthClientId: input.oauthClientId ?? null,
      provider: null,
      displayLabel: input.displayLabel ?? "MCP",
      status: "connected",
      isPrimary: !primary,
      capabilities: { inbox_available: true, push_reachable: false },
      lastAuthorizedAt: new Date(),
    })
    .returning();
  return created.id;
}

export async function listConnections(db: Database | Tx, principalId: string) {
  return db.select().from(agentConnections).where(eq(agentConnections.principalId, principalId));
}

export async function primaryConnectionId(db: Database | Tx, principalId: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(agentConnections)
    .where(
      and(
        eq(agentConnections.principalId, principalId),
        eq(agentConnections.status, "connected"),
        eq(agentConnections.isPrimary, true),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}
