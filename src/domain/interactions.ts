import { and, eq, or, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client.js";
import {
  approvalRequests,
  auditLogs,
  inboxItems,
  interactionEvents,
  interactions,
  proposals,
} from "../db/schema.js";
import { conflict, forbidden, invalidState, notFound } from "./errors.js";
import { findPrincipalByHandle, primaryConnectionId } from "./identity.js";
import { requirePermission } from "./relationships.js";
import type { Actor } from "./types.js";

const INTERACTION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const OPEN_STATUSES = new Set(["PENDING", "IN_PROGRESS", "AWAITING_OWNER"]);

async function appendEvent(
  db: Database | Tx,
  input: {
    interactionId: string;
    type: string;
    actorPrincipalId?: string | null;
    agentConnectionId?: string | null;
    payload?: Record<string, unknown>;
  },
) {
  await db.insert(interactionEvents).values({
    interactionId: input.interactionId,
    type: input.type,
    actorPrincipalId: input.actorPrincipalId ?? null,
    agentConnectionId: input.agentConnectionId ?? null,
    payload: input.payload ?? {},
  });
  await db.insert(auditLogs).values({
    actorPrincipalId: input.actorPrincipalId ?? null,
    agentConnectionId: input.agentConnectionId ?? null,
    action: input.type,
    entityType: "interaction",
    entityId: input.interactionId,
    payload: input.payload ?? {},
  });
}

async function loadInteraction(db: Database | Tx, id: string) {
  const [row] = await db.select().from(interactions).where(eq(interactions.id, id)).limit(1);
  if (!row) throw notFound("Interaction not found");
  return row;
}

function assertParticipant(interaction: { initiatorPrincipalId: string; recipientPrincipalId: string }, principalId: string) {
  if (
    interaction.initiatorPrincipalId !== principalId &&
    interaction.recipientPrincipalId !== principalId
  ) {
    throw forbidden("Not a participant");
  }
}

function counterparty(
  interaction: { initiatorPrincipalId: string; recipientPrincipalId: string },
  principalId: string,
) {
  return interaction.initiatorPrincipalId === principalId
    ? interaction.recipientPrincipalId
    : interaction.initiatorPrincipalId;
}

async function upsertInbox(
  db: Database | Tx,
  input: {
    principalId: string;
    interactionId: string;
    state: "unread" | "read" | "archived";
    assigneeAgentConnectionId?: string | null;
  },
) {
  const [existing] = await db
    .select()
    .from(inboxItems)
    .where(
      and(eq(inboxItems.principalId, input.principalId), eq(inboxItems.interactionId, input.interactionId)),
    )
    .limit(1);
  if (existing) {
    const [updated] = await db
      .update(inboxItems)
      .set({
        state: input.state,
        updatedAt: new Date(),
        assigneeAgentConnectionId:
          input.assigneeAgentConnectionId === undefined
            ? existing.assigneeAgentConnectionId
            : input.assigneeAgentConnectionId,
      })
      .where(eq(inboxItems.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await db
    .insert(inboxItems)
    .values({
      principalId: input.principalId,
      interactionId: input.interactionId,
      state: input.state,
      assigneeAgentConnectionId: input.assigneeAgentConnectionId ?? null,
    })
    .returning();
  return created;
}

export async function claimInboxItem(
  db: Database | Tx,
  input: { inboxItemId: string; connectionId: string },
) {
  const [row] = await db
    .update(inboxItems)
    .set({
      claimedByAgentConnectionId: input.connectionId,
      claimedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(inboxItems.id, input.inboxItemId),
        or(
          sql`${inboxItems.claimedByAgentConnectionId} is null`,
          eq(inboxItems.claimedByAgentConnectionId, input.connectionId),
        ),
      ),
    )
    .returning();
  if (!row) throw conflict("Inbox item already claimed");
  return row;
}

async function claimActorWork(
  db: Database | Tx,
  actor: Actor,
  interactionId: string,
) {
  if (!actor.connectionId) throw forbidden("No agent connection to claim with");
  const [item] = await db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.principalId, actor.principalId), eq(inboxItems.interactionId, interactionId)))
    .limit(1);
  if (!item) return null;
  return claimInboxItem(db, { inboxItemId: item.id, connectionId: actor.connectionId });
}

export async function createCoordinateInteraction(
  db: Database,
  actor: Actor,
  input: { toHandle: string; intent: string; constraints?: Record<string, unknown> | null },
) {
  const intent = input.intent.trim();
  if (!intent) throw invalidState("intent is required");
  const { principal: recipient } = await findPrincipalByHandle(db, input.toHandle);
  if (recipient.id === actor.principalId) throw forbidden("Cannot create an interaction with yourself");

  return db.transaction(async (tx) => {
    await requirePermission(tx, {
      grantorPrincipalId: recipient.id,
      granteePrincipalId: actor.principalId,
      capability: "messaging",
    });
    const assignee = await primaryConnectionId(tx, recipient.id);
    const [interaction] = await tx
      .insert(interactions)
      .values({
        type: "COORDINATE",
        intent,
        status: "PENDING",
        constraints: input.constraints ?? null,
        initiatorPrincipalId: actor.principalId,
        recipientPrincipalId: recipient.id,
        expiresAt: new Date(Date.now() + INTERACTION_TTL_MS),
      })
      .returning();
    const inbox = await upsertInbox(tx, {
      principalId: recipient.id,
      interactionId: interaction.id,
      state: "unread",
      assigneeAgentConnectionId: assignee,
    });
    await appendEvent(tx, {
      interactionId: interaction.id,
      type: "INTERACTION_CREATED",
      actorPrincipalId: actor.principalId,
      agentConnectionId: actor.connectionId,
      payload: { type: "COORDINATE" },
    });
    return { interaction, inbox };
  });
}

export async function respondToInteraction(db: Database, actor: Actor, interactionId: string) {
  return db.transaction(async (tx) => {
    const interaction = await loadInteraction(tx, interactionId);
    assertParticipant(interaction, actor.principalId);
    if (interaction.status !== "PENDING") {
      throw invalidState(`Cannot respond from ${interaction.status}`);
    }
    await claimActorWork(tx, actor, interaction.id);
    const [updated] = await tx
      .update(interactions)
      .set({ status: "IN_PROGRESS", updatedAt: new Date() })
      .where(eq(interactions.id, interaction.id))
      .returning();
    await upsertInbox(tx, {
      principalId: actor.principalId,
      interactionId: interaction.id,
      state: "read",
    });
    await appendEvent(tx, {
      interactionId: interaction.id,
      type: "INTERACTION_RESPONDED",
      actorPrincipalId: actor.principalId,
      agentConnectionId: actor.connectionId,
    });
    return { interaction: updated };
  });
}

export async function createTimeProposal(
  db: Database,
  actor: Actor,
  interactionId: string,
  payload: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const interaction = await loadInteraction(tx, interactionId);
    assertParticipant(interaction, actor.principalId);
    if (!OPEN_STATUSES.has(interaction.status) || interaction.status === "AWAITING_OWNER") {
      throw invalidState(`Cannot propose from ${interaction.status}`);
    }
    const other = counterparty(interaction, actor.principalId);
    await requirePermission(tx, {
      grantorPrincipalId: other,
      granteePrincipalId: actor.principalId,
      capability: "scheduling",
    });
    await claimActorWork(tx, actor, interaction.id);

    const [proposal] = await tx
      .insert(proposals)
      .values({
        interactionId: interaction.id,
        type: "TIME",
        payload,
        status: "PROPOSED",
        proposedByPrincipalId: actor.principalId,
      })
      .returning();
    const [approval] = await tx
      .insert(approvalRequests)
      .values({
        proposalId: proposal.id,
        interactionId: interaction.id,
        approverPrincipalId: other,
        status: "pending",
      })
      .returning();
    const [updated] = await tx
      .update(interactions)
      .set({ status: "AWAITING_OWNER", updatedAt: new Date() })
      .where(eq(interactions.id, interaction.id))
      .returning();
    await upsertInbox(tx, {
      principalId: actor.principalId,
      interactionId: interaction.id,
      state: "read",
    });
    await upsertInbox(tx, {
      principalId: other,
      interactionId: interaction.id,
      state: "unread",
      assigneeAgentConnectionId: await primaryConnectionId(tx, other),
    });
    await appendEvent(tx, {
      interactionId: interaction.id,
      type: "PROPOSAL_CREATED",
      actorPrincipalId: actor.principalId,
      agentConnectionId: actor.connectionId,
      payload: { proposal_id: proposal.id, type: "TIME" },
    });
    return { interaction: updated, proposal, approval };
  });
}

export async function approveProposal(db: Database, actor: Actor, proposalId: string) {
  return db.transaction(async (tx) => {
    const [proposal] = await tx.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
    if (!proposal) throw notFound("Proposal not found");
    const [approval] = await tx
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.proposalId, proposal.id))
      .limit(1);
    if (!approval) throw notFound("Approval request not found");

    if (approval.status === "approved" && proposal.status === "ACCEPTED") {
      const interaction = await loadInteraction(tx, proposal.interactionId);
      return { interaction, proposal, approval, idempotent: true };
    }
    if (approval.approverPrincipalId !== actor.principalId) throw forbidden("Not the approver");
    if (approval.status !== "pending") throw invalidState("Approval is not pending");
    if (proposal.status !== "PROPOSED") throw invalidState("Proposal is not proposed");

    await claimActorWork(tx, actor, proposal.interactionId);

    const [updatedApproval] = await tx
      .update(approvalRequests)
      .set({
        status: "approved",
        resolvedAt: new Date(),
        resolvedByPrincipalId: actor.principalId,
      })
      .where(and(eq(approvalRequests.id, approval.id), eq(approvalRequests.status, "pending")))
      .returning();
    if (!updatedApproval) throw conflict("Approval already resolved");

    const [updatedProposal] = await tx
      .update(proposals)
      .set({ status: "ACCEPTED", updatedAt: new Date() })
      .where(eq(proposals.id, proposal.id))
      .returning();
    const [updatedInteraction] = await tx
      .update(interactions)
      .set({ status: "AGREED", updatedAt: new Date() })
      .where(eq(interactions.id, proposal.interactionId))
      .returning();
    const [actorInbox, otherInbox] = await tx
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.interactionId, proposal.interactionId));
    void actorInbox;
    void otherInbox;
    await tx
      .update(inboxItems)
      .set({ state: "archived", updatedAt: new Date() })
      .where(eq(inboxItems.interactionId, proposal.interactionId));
    await appendEvent(tx, {
      interactionId: proposal.interactionId,
      type: "PROPOSAL_APPROVED",
      actorPrincipalId: actor.principalId,
      agentConnectionId: actor.connectionId,
      payload: { proposal_id: proposal.id },
    });
    return {
      interaction: updatedInteraction,
      proposal: updatedProposal,
      approval: updatedApproval,
      idempotent: false,
    };
  });
}

export async function rejectProposal(db: Database, actor: Actor, proposalId: string) {
  return db.transaction(async (tx) => {
    const [proposal] = await tx.select().from(proposals).where(eq(proposals.id, proposalId)).limit(1);
    if (!proposal) throw notFound("Proposal not found");
    const [approval] = await tx
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.proposalId, proposal.id))
      .limit(1);
    if (!approval) throw notFound("Approval request not found");
    if (approval.status === "rejected" && proposal.status === "REJECTED") {
      const interaction = await loadInteraction(tx, proposal.interactionId);
      return { interaction, proposal, approval, idempotent: true };
    }
    if (approval.approverPrincipalId !== actor.principalId) throw forbidden("Not the approver");
    if (approval.status !== "pending") throw invalidState("Approval is not pending");

    const [updatedApproval] = await tx
      .update(approvalRequests)
      .set({
        status: "rejected",
        resolvedAt: new Date(),
        resolvedByPrincipalId: actor.principalId,
      })
      .where(and(eq(approvalRequests.id, approval.id), eq(approvalRequests.status, "pending")))
      .returning();
    if (!updatedApproval) throw conflict("Approval already resolved");
    const [updatedProposal] = await tx
      .update(proposals)
      .set({ status: "REJECTED", updatedAt: new Date() })
      .where(eq(proposals.id, proposal.id))
      .returning();
    const [updatedInteraction] = await tx
      .update(interactions)
      .set({ status: "IN_PROGRESS", updatedAt: new Date() })
      .where(eq(interactions.id, proposal.interactionId))
      .returning();
    await upsertInbox(tx, {
      principalId: proposal.proposedByPrincipalId,
      interactionId: proposal.interactionId,
      state: "unread",
    });
    await upsertInbox(tx, {
      principalId: actor.principalId,
      interactionId: proposal.interactionId,
      state: "read",
    });
    await appendEvent(tx, {
      interactionId: proposal.interactionId,
      type: "PROPOSAL_REJECTED",
      actorPrincipalId: actor.principalId,
      agentConnectionId: actor.connectionId,
      payload: { proposal_id: proposal.id },
    });
    return {
      interaction: updatedInteraction,
      proposal: updatedProposal,
      approval: updatedApproval,
      idempotent: false,
    };
  });
}

export async function getInteractionBundle(db: Database | Tx, actor: Actor, interactionId: string) {
  const interaction = await loadInteraction(db, interactionId);
  assertParticipant(interaction, actor.principalId);
  const proposalRows = await db.select().from(proposals).where(eq(proposals.interactionId, interactionId));
  const approvalRows = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.interactionId, interactionId));
  const inbox = await db.select().from(inboxItems).where(eq(inboxItems.interactionId, interactionId));
  const events = await db
    .select()
    .from(interactionEvents)
    .where(eq(interactionEvents.interactionId, interactionId));
  const audits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, "interaction"), eq(auditLogs.entityId, interactionId)));
  return { interaction, proposals: proposalRows, approvals: approvalRows, inbox, events, audits };
}

export async function listInbox(db: Database | Tx, actor: Actor) {
  return db.select().from(inboxItems).where(eq(inboxItems.principalId, actor.principalId));
}
