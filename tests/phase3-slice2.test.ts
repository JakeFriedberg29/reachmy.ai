import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { handles, principals } from "../src/db/schema.js";
import { DomainError } from "../src/domain/errors.js";
import {
  createIdentity,
  ensureProvisionalPrincipal,
  getIdentityByAccountId,
  upsertAccountByClerkUser,
  upsertGrantConnection,
} from "../src/domain/identity.js";
import { executeTool, type McpToolContext } from "../src/mcp/tools.js";
import type { VerifiedPrincipal } from "../src/auth/verify-token.js";
import { suffix, testDb } from "./helpers.js";

async function principalCount(db: Awaited<ReturnType<typeof testDb>>, accountId: string): Promise<number> {
  const rows = await db.select().from(principals).where(eq(principals.accountId, accountId));
  return rows.length;
}

function mcpCtx(db: Awaited<ReturnType<typeof testDb>>, principal: VerifiedPrincipal): McpToolContext {
  return { db, principal, publicUrl: "http://localhost:3000" };
}

async function mcpCall(
  db: Awaited<ReturnType<typeof testDb>>,
  principal: VerifiedPrincipal,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await executeTool(mcpCtx(db, principal), name, args);
  if (result.isError) {
    const data = result.data as { error: string; message: string };
    const error = new Error(`${data.error}: ${data.message}`) as Error & { code: string };
    error.code = data.error;
    throw error;
  }
  return result.data as Record<string, unknown>;
}

test("Slice 2A: ensureProvisionalPrincipal creates one principal without handle", async () => {
  const db = await testDb();
  const tag = suffix();
  const account = await upsertAccountByClerkUser(db, {
    clerkUserId: `prov_${tag}`,
    email: `prov_${tag}@example.test`,
  });
  const identity = await ensureProvisionalPrincipal(db, account.account_id);
  assert.ok(identity.principal_id);
  assert.equal(identity.handle, null);
  assert.equal(identity.agent_name, null);
  assert.equal(identity.onboarding, "ONBOARDING_REQUIRED");
  assert.equal(await principalCount(db, account.account_id), 1);
  const handleRows = await db
    .select()
    .from(handles)
    .where(eq(handles.principalId, identity.principal_id!));
  assert.equal(handleRows.length, 0);
});

test("Slice 2B: ensureProvisionalPrincipal is idempotent", async () => {
  const db = await testDb();
  const tag = suffix();
  const account = await upsertAccountByClerkUser(db, {
    clerkUserId: `prov_idem_${tag}`,
    email: `prov_idem_${tag}@example.test`,
  });
  const first = await ensureProvisionalPrincipal(db, account.account_id);
  const second = await ensureProvisionalPrincipal(db, account.account_id);
  assert.equal(second.principal_id, first.principal_id);
  assert.equal(second.onboarding, "ONBOARDING_REQUIRED");
  assert.equal(await principalCount(db, account.account_id), 1);
});

test("Slice 2C: createIdentity claims handle on existing provisional principal", async () => {
  const db = await testDb();
  const tag = suffix();
  const handle = `claim_${tag}`.slice(0, 30);
  const account = await upsertAccountByClerkUser(db, {
    clerkUserId: `prov_claim_${tag}`,
    email: `prov_claim_${tag}@example.test`,
  });
  const provisional = await ensureProvisionalPrincipal(db, account.account_id);
  const claimed = await createIdentity(db, account.account_id, {
    handle,
    displayName: "Claimed User",
  });
  assert.equal(claimed.principal_id, provisional.principal_id);
  assert.equal(claimed.handle, handle);
  assert.equal(claimed.agent_name, `@${handle}`);
  assert.equal(claimed.onboarding, "complete");
  assert.equal(claimed.display_name, "Claimed User");
});

test("Slice 2D: exactly one personal principal remains after provisional claim", async () => {
  const db = await testDb();
  const tag = suffix();
  const handle = `one_${tag}`.slice(0, 30);
  const account = await upsertAccountByClerkUser(db, {
    clerkUserId: `prov_one_${tag}`,
    email: `prov_one_${tag}@example.test`,
  });
  await ensureProvisionalPrincipal(db, account.account_id);
  await createIdentity(db, account.account_id, { handle, displayName: "One Principal" });
  assert.equal(await principalCount(db, account.account_id), 1);
});

test("Slice 2E: direct createIdentity without provisional principal still works", async () => {
  const db = await testDb();
  const tag = suffix();
  const handle = `direct_${tag}`.slice(0, 30);
  const account = await upsertAccountByClerkUser(db, {
    clerkUserId: `direct_${tag}`,
    email: `direct_${tag}@example.test`,
  });
  const identity = await createIdentity(db, account.account_id, {
    handle,
    displayName: "Direct Claim",
  });
  assert.ok(identity.principal_id);
  assert.equal(identity.handle, handle);
  assert.equal(identity.onboarding, "complete");
  assert.equal(await principalCount(db, account.account_id), 1);
});

test("Slice 2F: already-claimed account rejects second createIdentity", async () => {
  const db = await testDb();
  const tag = suffix();
  const handle = `claimed_${tag}`.slice(0, 30);
  const account = await upsertAccountByClerkUser(db, {
    clerkUserId: `claimed_${tag}`,
    email: `claimed_${tag}@example.test`,
  });
  await createIdentity(db, account.account_id, { handle, displayName: "First" });
  await assert.rejects(
    () => createIdentity(db, account.account_id, { handle: `other_${tag}`.slice(0, 30), displayName: "Second" }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "conflict");
      return true;
    },
  );
});

test("Slice 2G: handle uniqueness enforced across provisional and direct claims", async () => {
  const db = await testDb();
  const tag = suffix();
  const handle = `uniq_${tag}`.slice(0, 30);
  const a = await upsertAccountByClerkUser(db, { clerkUserId: `uniq_a_${tag}` });
  const b = await upsertAccountByClerkUser(db, { clerkUserId: `uniq_b_${tag}` });
  await ensureProvisionalPrincipal(db, a.account_id);
  await createIdentity(db, a.account_id, { handle, displayName: "First" });
  await ensureProvisionalPrincipal(db, b.account_id);
  await assert.rejects(
    () => createIdentity(db, b.account_id, { handle, displayName: "Second" }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "conflict");
      assert.match(error.message, /already taken/i);
      return true;
    },
  );
});

test("Slice 2H: MCP create_identity claims provisional principal", async () => {
  const db = await testDb();
  const tag = suffix();
  const handle = `mcp_${tag}`.slice(0, 30);
  const account = await upsertAccountByClerkUser(db, {
    clerkUserId: `mcp_prov_${tag}`,
    email: `mcp_prov_${tag}@example.test`,
  });
  const provisional = await ensureProvisionalPrincipal(db, account.account_id);
  const grantId = `onboard:${tag}`;
  const principal: VerifiedPrincipal = {
    accountId: account.account_id,
    principalId: provisional.principal_id!,
    handle: "",
    displayName: provisional.display_name ?? "",
    grantId,
    clientId: grantId,
    connectionId: null,
    onboarding: "ONBOARDING_REQUIRED",
  };
  const created = await mcpCall(db, principal, "create_identity", {
    agent_name: `@${handle}`,
    display_name: "MCP Claimer",
  });
  assert.equal(created.principal_id, provisional.principal_id);
  assert.equal(created.agent_name, `@${handle}`);
  assert.equal(created.onboarding, "complete");
  assert.equal(created.display_name, "MCP Claimer");
  assert.ok(created.agent_connection_id);
  const after = await getIdentityByAccountId(db, account.account_id);
  assert.equal(after.principal_id, provisional.principal_id);
  assert.equal(after.onboarding, "complete");
});

test("Slice 2: upsertGrantConnection binds to provisional principal", async () => {
  const db = await testDb();
  const tag = suffix();
  const account = await upsertAccountByClerkUser(db, {
    clerkUserId: `grant_${tag}`,
    email: `grant_${tag}@example.test`,
  });
  const provisional = await ensureProvisionalPrincipal(db, account.account_id);
  const grantId = `Claude:${provisional.principal_id}:${tag}`;
  const connectionId = await upsertGrantConnection(db, {
    principalId: provisional.principal_id!,
    grantId,
    oauthClientId: grantId,
    displayLabel: "Claude",
  });
  assert.ok(connectionId);
  assert.equal(await principalCount(db, account.account_id), 1);
  const identity = await getIdentityByAccountId(db, account.account_id);
  assert.equal(identity.onboarding, "ONBOARDING_REQUIRED");
  assert.equal(identity.handle, null);
});

test("Slice 2: ensureProvisionalPrincipal leaves claimed principal unchanged", async () => {
  const db = await testDb();
  const tag = suffix();
  const handle = `keep_${tag}`.slice(0, 30);
  const account = await upsertAccountByClerkUser(db, {
    clerkUserId: `keep_${tag}`,
    email: `keep_${tag}@example.test`,
  });
  const claimed = await createIdentity(db, account.account_id, { handle, displayName: "Keeper" });
  const again = await ensureProvisionalPrincipal(db, account.account_id);
  assert.equal(again.principal_id, claimed.principal_id);
  assert.equal(again.handle, handle);
  assert.equal(again.onboarding, "complete");
});

test("Slice 2: provisional display name uses account email until claim", async () => {
  const db = await testDb();
  const tag = suffix();
  const email = `display_${tag}@example.test`;
  const account = await upsertAccountByClerkUser(db, {
    clerkUserId: `display_${tag}`,
    email,
  });
  const provisional = await ensureProvisionalPrincipal(db, account.account_id);
  assert.equal(provisional.display_name, email);
  const handle = `disp_${tag}`.slice(0, 30);
  const claimed = await createIdentity(db, account.account_id, { handle, displayName: "Proper Name" });
  assert.equal(claimed.display_name, "Proper Name");
});
