import assert from "node:assert/strict";
import { test } from "node:test";
import { upsertAccountByClerkUser, upsertGrantConnection, getIdentityByAccountId } from "../src/domain/identity.js";
import { getInteractionBundle } from "../src/domain/interactions.js";
import { executeTool, type McpToolContext } from "../src/mcp/tools.js";
import type { VerifiedPrincipal } from "../src/auth/verify-token.js";
import { makeGrantPrincipal, suffix, testDb } from "./helpers.js";

function ctx(db: Awaited<ReturnType<typeof testDb>>, principal: VerifiedPrincipal): McpToolContext {
  return { db, principal, publicUrl: "http://localhost:3000" };
}

async function call(
  db: Awaited<ReturnType<typeof testDb>>,
  principal: VerifiedPrincipal,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await executeTool(ctx(db, principal), name, args);
  if (result.isError) {
    const data = result.data as { error: string; message: string };
    const error = new Error(`${data.error}: ${data.message}`) as Error & { code: string };
    error.code = data.error;
    throw error;
  }
  return result.data as Record<string, never> & {
    agent_name?: string;
    handle?: string;
    onboarding?: string;
    principal_id?: string;
    token?: string;
    relationship_id?: string;
    interaction?: { id: string; status: string };
    proposal?: { id: string; status: string; type: string };
    approval?: { status: string };
    items?: Array<{ interaction_id: string; status: string; other_agent_name: string | null }>;
    connections?: Array<{ agent_name?: string; agent_connection_id?: string; status?: string }>;
    status?: string;
    agent_connection_id?: string;
    display_name?: string;
  };
}

test("MCP adapter: Agent Name claim and resolve", async () => {
  const db = await testDb();
  const tag = `an_${suffix()}`.slice(0, 30);
  const account = await upsertAccountByClerkUser(db, { clerkUserId: `clerk_${tag}` });
  const principal: VerifiedPrincipal = {
    accountId: account.account_id,
    principalId: "",
    handle: "",
    displayName: "",
    grantId: `onboard:${tag}`,
    clientId: `onboard:${tag}`,
    connectionId: null,
    onboarding: "ONBOARDING_REQUIRED",
  };
  await assert.rejects(() => call(db, principal, "create_invite"), /onboarding_required|Choose your Agent Name/);
  const created = await call(db, principal, "create_identity", {
    agent_name: `@${tag}`,
    display_name: "Onboarder",
  });
  assert.equal(created.agent_name, `@${tag}`);
  assert.equal(created.onboarding, "complete");
  assert.ok(created.principal_id);
  const onboarded: VerifiedPrincipal = {
    ...principal,
    principalId: created.principal_id!,
    handle: tag,
    displayName: "Onboarder",
    connectionId: created.agent_connection_id ?? null,
    onboarding: "complete",
  };
  const me = await call(db, onboarded, "get_my_identity");
  assert.equal(me.agent_name, `@${tag}`);
  const alias = await call(db, onboarded, "get_identity");
  assert.equal(alias.agent_name, `@${tag}`);
  const resolved = await call(db, onboarded, "resolve_identity", { agent_name: `@${tag}` });
  assert.equal(resolved.agent_name, `@${tag}`);
  assert.equal(resolved.display_name, "Onboarder");
});

test("MCP adapter: Agent Name → relationship → COORDINATE → TIME → AGREED", async () => {
  const db = await testDb();
  const jake = await makeGrantPrincipal(db, "mcpj");
  const daniel = await makeGrantPrincipal(db, "mcpd");
  const invite = await call(db, jake.principal, "create_invite");
  const accepted = await call(db, daniel.principal, "accept_invite", { token: invite.token });
  assert.ok(accepted.relationship_id);
  const created = await call(db, jake.principal, "create_interaction", {
    to: daniel.identity.agent_name,
    intent: "Find 30 minutes",
  });
  assert.equal(created.interaction?.status, "PENDING");
  const pending = await call(db, daniel.principal, "list_pending_interactions");
  assert.ok(pending.items?.some((item) => item.interaction_id === created.interaction?.id));
  const proposed = await call(db, daniel.principal, "create_proposal", {
    interaction_id: created.interaction!.id,
    type: "TIME",
    start: "2026-08-20T15:00:00Z",
    end: "2026-08-20T15:30:00Z",
  });
  assert.equal(proposed.interaction?.status, "AWAITING_OWNER");
  assert.equal(proposed.proposal?.type, "TIME");
  const approved = await call(db, jake.principal, "approve_proposal", {
    proposal_id: proposed.proposal!.id,
  });
  assert.equal(approved.interaction?.status, "AGREED");
  const bundle = await call(db, jake.principal, "get_interaction", {
    interaction_id: created.interaction!.id,
  });
  assert.equal(bundle.interaction?.status, "AGREED");
});

test("MCP adapter: revoke AI connection without deleting Agent Name", async () => {
  const db = await testDb();
  const jake = await makeGrantPrincipal(db, "revj", "Claude");
  const otherGrant = `ChatGPT:${jake.identity.principal_id}:${suffix()}`;
  const otherConnectionId = await upsertGrantConnection(db, {
    principalId: jake.identity.principal_id!,
    grantId: otherGrant,
    oauthClientId: otherGrant,
    displayLabel: "ChatGPT",
  });
  const jakeOther: VerifiedPrincipal = {
    ...jake.principal,
    grantId: otherGrant,
    clientId: otherGrant,
    connectionId: otherConnectionId,
  };
  const daniel = await makeGrantPrincipal(db, "revd");
  const invite = await call(db, jake.principal, "create_invite");
  await call(db, daniel.principal, "accept_invite", { token: invite.token });
  const created = await call(db, daniel.principal, "create_interaction", {
    to: jake.identity.agent_name,
    intent: "Need a slot",
  });
  const proposed = await call(db, jake.principal, "create_proposal", {
    interaction_id: created.interaction!.id,
    start: "2026-08-21T16:00:00Z",
  });
  const before = await getInteractionBundle(db, jake.actor, created.interaction!.id);
  assert.ok(before.inbox.some((item) => item.claimedByAgentConnectionId === jake.actor.connectionId));

  const revoked = await call(db, jake.principal, "revoke_agent_connection", {
    agent_connection_id: jake.principal.connectionId,
  });
  assert.equal(revoked.status, "revoked");

  await assert.rejects(
    () => call(db, jake.principal, "get_my_identity"),
    /revoked|unauthorized/,
  );

  const still = await call(db, jakeOther, "get_my_identity");
  assert.equal(still.agent_name, jake.identity.agent_name);
  assert.equal(still.principal_id, jake.identity.principal_id);
  const identity = await getIdentityByAccountId(db, jake.identity.account_id);
  assert.equal(identity.agent_name, jake.identity.agent_name);
  assert.equal(identity.onboarding, "complete");

  const after = await getInteractionBundle(db, {
    accountId: jake.identity.account_id,
    principalId: jake.identity.principal_id!,
    connectionId: otherConnectionId,
  }, created.interaction!.id);
  assert.equal(
    after.inbox.find((item) => item.principalId === jake.identity.principal_id)?.claimedByAgentConnectionId,
    null,
  );

  const approved = await call(db, daniel.principal, "approve_proposal", { proposal_id: proposed.proposal!.id });
  assert.equal(approved.interaction?.status, "AGREED");

  const listed = await call(db, jakeOther, "list_agent_connections");
  const statuses = new Map(listed.connections?.map((row) => [row.agent_connection_id, row.status]));
  assert.equal(statuses.get(jake.principal.connectionId!), "revoked");
  assert.equal(statuses.get(otherConnectionId), "connected");
});
