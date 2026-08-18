import type { VerifiedPrincipal } from "../auth/verify-token.js";
import type { Database } from "../db/client.js";
import { CONNECTION_REVOKED, publicAgentConnection, revokeAgentConnection } from "../domain/connections.js";
import { onboardingRequired, unauthorized } from "../domain/errors.js";
import {
  createIdentity,
  getConnectionById,
  getIdentityByAccountId,
  isApiConnection,
  listConnections,
  resolveIdentity,
  upsertGrantConnection,
} from "../domain/identity.js";
import {
  acceptInvite,
  createInvite,
} from "../domain/invites.js";
import {
  approveProposal,
  createCoordinateInteraction,
  createTimeProposal,
  getInteractionBundle,
  listPendingInteractions,
  rejectProposal,
  respondToInteraction,
} from "../domain/interactions.js";
import {
  getRelationshipPermissionsView,
  listRelationshipsFor,
  setRelationshipPermissions,
} from "../domain/relationships.js";
import type { Actor } from "../domain/types.js";
import { fromCaught, toolErr, toolOk, type ToolResult } from "./result.js";

export type McpToolContext = {
  db: Database;
  principal: VerifiedPrincipal;
  publicUrl: string;
};

const ONBOARDING_TOOLS = new Set(["get_my_identity", "get_identity", "create_identity", "resolve_identity"]);

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function obj(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

async function assertConnectionNotRevoked(ctx: McpToolContext): Promise<void> {
  if (!ctx.principal.connectionId) return;
  const connection = await getConnectionById(ctx.db, ctx.principal.connectionId);
  if (!connection || connection.status === CONNECTION_REVOKED) {
    throw unauthorized("This AI connection has been revoked and can no longer represent this Agent Name");
  }
}

async function requireActiveActor(ctx: McpToolContext, tool: string): Promise<Actor> {
  await assertConnectionNotRevoked(ctx);
  if (ctx.principal.onboarding === "ONBOARDING_REQUIRED" || !ctx.principal.principalId) {
    throw onboardingRequired("Choose your Agent Name first (example: @jake). Call create_identity.");
  }
  if (!ONBOARDING_TOOLS.has(tool) && !ctx.principal.connectionId) {
    throw unauthorized("This grant has no AI connection");
  }
  return {
    accountId: ctx.principal.accountId,
    principalId: ctx.principal.principalId,
    connectionId: ctx.principal.connectionId,
  };
}

function mcpIdentity(
  identity: {
    account_id: string;
    principal_id: string | null;
    handle: string | null;
    agent_name: string | null;
    display_name: string | null;
    onboarding: "complete" | "ONBOARDING_REQUIRED";
  },
  connectionId: string | null,
) {
  return {
    agent_name: identity.agent_name,
    display_name: identity.display_name,
    principal_id: identity.principal_id,
    account_id: identity.account_id,
    onboarding: identity.onboarding,
    agent_connection_id: connectionId,
    onboarding_prompt:
      identity.onboarding === "ONBOARDING_REQUIRED"
        ? "Choose your Agent Name (example: @jake). Then call create_identity."
        : null,
  };
}

export async function executeTool(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    await assertConnectionNotRevoked(ctx);
    switch (name) {
      case "get_identity":
      case "get_my_identity":
        return toolOk(
          mcpIdentity(await getIdentityByAccountId(ctx.db, ctx.principal.accountId), ctx.principal.connectionId),
        );

      case "create_identity": {
        if (ctx.principal.onboarding === "complete" && ctx.principal.principalId) {
          return toolErr("conflict", "An Agent Name already exists for this account");
        }
        const handle = str(args.agent_name || args.handle);
        const displayName = str(args.display_name || args.displayName) || handle.replace(/^@/, "");
        const identity = await createIdentity(ctx.db, ctx.principal.accountId, { handle, displayName });
        let connectionId = ctx.principal.connectionId;
        if (identity.principal_id && ctx.principal.grantId) {
          connectionId = await upsertGrantConnection(ctx.db, {
            principalId: identity.principal_id,
            grantId: ctx.principal.grantId,
            oauthClientId: ctx.principal.clientId,
            displayLabel: "MCP",
          });
        }
        return toolOk(mcpIdentity(identity, connectionId));
      }

      case "resolve_identity":
        return toolOk(await resolveIdentity(ctx.db, str(args.agent_name || args.handle)));

      case "create_invite": {
        const actor = await requireActiveActor(ctx, name);
        const { invite, token } = await createInvite(ctx.db, actor);
        return toolOk({
          invite_id: invite.id,
          token,
          expires_at: invite.expiresAt.toISOString(),
          accept_url: `${ctx.publicUrl}/invite/${token}`,
        });
      }

      case "accept_invite": {
        const actor = await requireActiveActor(ctx, name);
        const result = await acceptInvite(ctx.db, actor, str(args.token));
        return toolOk({
          relationship_id: result.relationship.id,
          invite_id: result.invite.id,
        });
      }

      case "list_connections": {
        const actor = await requireActiveActor(ctx, name);
        return toolOk({ connections: await listRelationshipsFor(ctx.db, actor.principalId) });
      }

      case "get_relationship_permissions": {
        const actor = await requireActiveActor(ctx, name);
        return toolOk(
          await getRelationshipPermissionsView(ctx.db, actor, str(args.agent_name || args.handle)),
        );
      }

      case "set_relationship_permissions": {
        const actor = await requireActiveActor(ctx, name);
        return toolOk(
          await setRelationshipPermissions(ctx.db, actor, {
            otherHandle: str(args.agent_name || args.handle),
            messaging: bool(args.messaging),
            scheduling: bool(args.scheduling),
            negotiation: bool(args.negotiation),
          }),
        );
      }

      case "create_interaction": {
        const actor = await requireActiveActor(ctx, name);
        const type = str(args.type || "COORDINATE").toUpperCase();
        if (type !== "COORDINATE") {
          return toolErr("unsupported_type", "Phase 1 supports COORDINATE only");
        }
        const result = await createCoordinateInteraction(ctx.db, actor, {
          toHandle: str(args.to || args.agent_name || args.to_handle),
          intent: str(args.intent),
          constraints: obj(args.constraints),
        });
        return toolOk(result);
      }

      case "list_pending_interactions": {
        const actor = await requireActiveActor(ctx, name);
        return toolOk({ items: await listPendingInteractions(ctx.db, actor) });
      }

      case "get_interaction": {
        const actor = await requireActiveActor(ctx, name);
        const bundle = await getInteractionBundle(ctx.db, actor, str(args.interaction_id || args.id));
        return toolOk({
          interaction: bundle.interaction,
          proposals: bundle.proposals,
          approvals: bundle.approvals,
          inbox: bundle.inbox.filter((item) => item.principalId === actor.principalId),
        });
      }

      case "respond_to_interaction": {
        const actor = await requireActiveActor(ctx, name);
        return toolOk(
          await respondToInteraction(ctx.db, actor, str(args.interaction_id || args.id)),
        );
      }

      case "create_proposal": {
        const actor = await requireActiveActor(ctx, name);
        const type = str(args.type || "TIME").toUpperCase();
        if (type !== "TIME") return toolErr("unsupported_type", "Phase 1 supports TIME proposals only");
        const payload = obj(args.payload) ?? {
          ...(args.start ? { start: args.start } : {}),
          ...(args.end ? { end: args.end } : {}),
          ...(args.timezone ? { timezone: args.timezone } : {}),
        };
        return toolOk(
          await createTimeProposal(ctx.db, actor, str(args.interaction_id || args.id), payload),
        );
      }

      case "approve_proposal": {
        const actor = await requireActiveActor(ctx, name);
        return toolOk(await approveProposal(ctx.db, actor, str(args.proposal_id || args.id)));
      }

      case "reject_proposal": {
        const actor = await requireActiveActor(ctx, name);
        return toolOk(await rejectProposal(ctx.db, actor, str(args.proposal_id || args.id)));
      }

      case "list_agent_connections": {
        const actor = await requireActiveActor(ctx, name);
        const rows = await listConnections(ctx.db, actor.principalId);
        return toolOk({
          agent_name: ctx.principal.handle ? `@${ctx.principal.handle}` : null,
          connections: rows
            .filter((row) => !isApiConnection(row.grantId))
            .map(publicAgentConnection),
        });
      }

      case "request_disconnect_agent":
      case "revoke_agent_connection": {
        const actor = await requireActiveActor(ctx, name);
        const requested = str(args.agent_connection_id || args.id);
        const connectionId = requested === "current" || !requested ? actor.connectionId : requested;
        if (!connectionId) return toolErr("invalid_connection", "agent_connection_id is required");
        const result = await revokeAgentConnection(ctx.db, actor, connectionId);
        return toolOk({
          agent_connection_id: result.connection.id,
          status: result.connection.status,
          idempotent: result.idempotent,
          released_interaction_ids: result.released_interaction_ids,
          note: "This AI connection can no longer represent your Agent Name. Your Agent Name, account, relationships, and other AI connections are unchanged. Intended production UX: confirm revoke in the browser; this tool is the backend capability for testing.",
        });
      }

      default:
        return toolErr("unknown_tool", `Unknown tool ${name}`);
    }
  } catch (error) {
    return fromCaught(error);
  }
}
