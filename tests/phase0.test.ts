import assert from "node:assert/strict";
import { test } from "node:test";
import { agentConnections } from "../src/db/schema.js";
import { DomainError } from "../src/domain/errors.js";
import { createIdentity, upsertAccountByClerkUser } from "../src/domain/identity.js";
import { acceptInvite, createInvite } from "../src/domain/invites.js";
import {
  approveProposal,
  claimInboxItem,
  createCoordinateInteraction,
  createTimeProposal,
  getInteractionBundle,
  rejectProposal,
} from "../src/domain/interactions.js";
import { setPermissionFlag } from "../src/domain/relationships.js";
import { makePrincipal, suffix, testDb } from "./helpers.js";

test("COORDINATE then TIME then approve reaches AGREED", async () => {
  const db = await testDb();
  const jake = await makePrincipal(db, "jake");
  const daniel = await makePrincipal(db, "dan");
  const { token } = await createInvite(db, jake.actor);
  await acceptInvite(db, daniel.actor, token);
  const created = await createCoordinateInteraction(db, jake.actor, {
    toHandle: daniel.identity.handle!,
    intent: "Pick a time to talk",
  });
  assert.equal(created.interaction.status, "PENDING");
  const proposed = await createTimeProposal(db, daniel.actor, created.interaction.id, {
    start: "2026-08-20T15:00:00Z",
    end: "2026-08-20T15:30:00Z",
  });
  assert.equal(proposed.interaction.status, "AWAITING_OWNER");
  assert.equal(proposed.proposal.status, "PROPOSED");
  assert.equal(proposed.approval.status, "pending");
  const approved = await approveProposal(db, jake.actor, proposed.proposal.id);
  assert.equal(approved.interaction.status, "AGREED");
  assert.equal(approved.proposal.status, "ACCEPTED");
  assert.equal(approved.approval.status, "approved");
  const bundle = await getInteractionBundle(db, jake.actor, created.interaction.id);
  assert.equal(bundle.inbox.every((item) => item.state === "archived"), true);
  assert.ok(bundle.events.some((event) => event.type === "INTERACTION_CREATED"));
  assert.ok(bundle.events.some((event) => event.type === "PROPOSAL_CREATED"));
  assert.ok(bundle.events.some((event) => event.type === "PROPOSAL_APPROVED"));
  assert.ok(bundle.audits.length >= 3);
});

test("directional messaging deny blocks COORDINATE", async () => {
  const db = await testDb();
  const jake = await makePrincipal(db, "permj");
  const daniel = await makePrincipal(db, "permd");
  const { token } = await createInvite(db, jake.actor);
  await acceptInvite(db, daniel.actor, token);
  await setPermissionFlag(db, {
    actorPrincipalId: daniel.actor.principalId,
    otherPrincipalId: jake.actor.principalId,
    capability: "messaging",
    value: false,
  });
  await assert.rejects(
    () =>
      createCoordinateInteraction(db, jake.actor, {
        toHandle: daniel.identity.handle!,
        intent: "hello",
      }),
    /messaging/,
  );
});

test("directional scheduling deny blocks TIME proposal", async () => {
  const db = await testDb();
  const jake = await makePrincipal(db, "timej");
  const daniel = await makePrincipal(db, "timed");
  const { token } = await createInvite(db, jake.actor);
  await acceptInvite(db, daniel.actor, token);
  const created = await createCoordinateInteraction(db, jake.actor, {
    toHandle: daniel.identity.handle!,
    intent: "find a slot",
  });
  await setPermissionFlag(db, {
    actorPrincipalId: jake.actor.principalId,
    otherPrincipalId: daniel.actor.principalId,
    capability: "scheduling",
    value: false,
  });
  await assert.rejects(
    () => createTimeProposal(db, daniel.actor, created.interaction.id, { start: "2026-08-21T16:00:00Z" }),
    /scheduling/,
  );
});

test("invite is single-use", async () => {
  const db = await testDb();
  const jake = await makePrincipal(db, "invj");
  const daniel = await makePrincipal(db, "invd");
  const other = await makePrincipal(db, "invo");
  const { token } = await createInvite(db, jake.actor);
  const first = await acceptInvite(db, daniel.actor, token);
  assert.ok(first.relationship.id);
  await assert.rejects(() => acceptInvite(db, other.actor, token), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "conflict");
    return true;
  });
});

test("concurrent claims: exactly one winner", async () => {
  const db = await testDb();
  const jake = await makePrincipal(db, "clmj");
  const daniel = await makePrincipal(db, "clmd");
  const { token } = await createInvite(db, jake.actor);
  await acceptInvite(db, daniel.actor, token);
  const created = await createCoordinateInteraction(db, jake.actor, {
    toHandle: daniel.identity.handle!,
    intent: "claim race",
  });
  const [second] = await db
    .insert(agentConnections)
    .values({
      principalId: daniel.actor.principalId,
      grantId: `race:${daniel.actor.principalId}`,
      oauthClientId: `race:${daniel.actor.principalId}`,
      displayLabel: "racer",
      status: "connected",
      isPrimary: false,
      capabilities: {},
    })
    .returning();

  const results = await Promise.allSettled([
    claimInboxItem(db, { inboxItemId: created.inbox.id, connectionId: daniel.actor.connectionId! }),
    claimInboxItem(db, { inboxItemId: created.inbox.id, connectionId: second.id }),
  ]);
  const wins = results.filter((r) => r.status === "fulfilled");
  const losses = results.filter((r) => r.status === "rejected");
  assert.equal(wins.length, 1);
  assert.equal(losses.length, 1);
  const loss = losses[0] as PromiseRejectedResult;
  assert.ok(loss.reason instanceof DomainError);
  assert.equal(loss.reason.code, "conflict");
});

test("approve is transactional and idempotent", async () => {
  const db = await testDb();
  const jake = await makePrincipal(db, "apj");
  const daniel = await makePrincipal(db, "apd");
  const { token } = await createInvite(db, jake.actor);
  await acceptInvite(db, daniel.actor, token);
  const created = await createCoordinateInteraction(db, jake.actor, {
    toHandle: daniel.identity.handle!,
    intent: "approve me",
  });
  const proposed = await createTimeProposal(db, daniel.actor, created.interaction.id, {
    start: "2026-08-22T18:00:00Z",
  });
  const first = await approveProposal(db, jake.actor, proposed.proposal.id);
  const second = await approveProposal(db, jake.actor, proposed.proposal.id);
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(second.interaction.status, "AGREED");
  const bundle = await getInteractionBundle(db, jake.actor, created.interaction.id);
  assert.equal(bundle.proposals[0]?.status, "ACCEPTED");
  assert.equal(bundle.approvals[0]?.status, "approved");
  assert.equal(bundle.interaction.status, "AGREED");
});

test("reject is transactional and returns IN_PROGRESS", async () => {
  const db = await testDb();
  const jake = await makePrincipal(db, "rj");
  const daniel = await makePrincipal(db, "rd");
  const { token } = await createInvite(db, jake.actor);
  await acceptInvite(db, daniel.actor, token);
  const created = await createCoordinateInteraction(db, jake.actor, {
    toHandle: daniel.identity.handle!,
    intent: "reject me",
  });
  const proposed = await createTimeProposal(db, daniel.actor, created.interaction.id, {
    start: "2026-08-22T19:00:00Z",
  });
  const rejected = await rejectProposal(db, jake.actor, proposed.proposal.id);
  assert.equal(rejected.interaction.status, "IN_PROGRESS");
  assert.equal(rejected.proposal.status, "REJECTED");
  assert.equal(rejected.approval.status, "rejected");
  const again = await rejectProposal(db, jake.actor, proposed.proposal.id);
  assert.equal(again.idempotent, true);
});

test("handle uniqueness is enforced", async () => {
  const db = await testDb();
  const handle = `uniq_${suffix()}`.slice(0, 30);
  const a = await upsertAccountByClerkUser(db, { clerkUserId: `h1_${handle}` });
  const b = await upsertAccountByClerkUser(db, { clerkUserId: `h2_${handle}` });
  await createIdentity(db, a.account_id, { handle, displayName: "One" });
  await assert.rejects(
    () => createIdentity(db, b.account_id, { handle, displayName: "Two" }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "conflict");
      return true;
    },
  );
});
