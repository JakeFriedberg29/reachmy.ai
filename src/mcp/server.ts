import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { VerifiedPrincipal } from "../auth/verify-token.js";
import type { Database } from "../db/client.js";
import { mcpContent } from "./result.js";
import { executeTool } from "./tools.js";

export type NetworkMcpOptions = {
  db: Database;
  principal: VerifiedPrincipal;
  publicUrl: string;
};

function tool(
  server: McpServer,
  opts: NetworkMcpOptions,
  name: string,
  description: string,
  inputSchema: z.ZodType,
  readOnly = false,
) {
  server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: readOnly ? { readOnlyHint: true } : undefined,
    },
    async (args) => mcpContent(await executeTool(opts, name, args as Record<string, unknown>)),
  );
}

export function createNetworkMcpServer(opts: NetworkMcpOptions) {
  const server = new McpServer({
    name: "reachmy-ai",
    version: "0.1.0",
  });

  tool(
    server,
    opts,
    "get_my_identity",
    "Return the signed-in ReachMy identity, including Agent Name (example: @jake). Agent Name is your durable identity — not Claude, ChatGPT, or OpenClaw. Those are AI connections that may represent this Agent Name. If none is claimed yet, onboarding is required.",
    z.object({}),
    true,
  );
  tool(
    server,
    opts,
    "get_identity",
    "Alias of get_my_identity. Return the signed-in ReachMy identity, including Agent Name.",
    z.object({}),
    true,
  );
  tool(
    server,
    opts,
    "create_identity",
    "Claim your Agent Name (your durable ReachMy identity, like a username). Example: @jake. This does not create a Claude/ChatGPT/OpenClaw account — it creates the identity those AIs may represent. Only allowed once, while onboarding is required.",
    z.object({
      agent_name: z.string().min(3).describe("Desired Agent Name, with or without @ (example: jake or @jake)"),
      display_name: z.string().min(1).optional().describe("Human display name; defaults to the Agent Name"),
    }),
  );
  tool(
    server,
    opts,
    "resolve_identity",
    "Look up a public Agent Name such as @daniel. Returns display name and principal id, not account or email.",
    z.object({
      agent_name: z.string().min(1).describe("Agent Name to resolve, with or without @"),
    }),
    true,
  );

  tool(
    server,
    opts,
    "create_invite",
    "Create an invite link so someone can connect their Agent Name to yours. Share the token or accept_url.",
    z.object({}),
  );
  tool(
    server,
    opts,
    "accept_invite",
    "Accept an invite token and create an active relationship between Agent Names.",
    z.object({
      token: z.string().min(1).describe("Invite token from create_invite"),
    }),
  );
  tool(
    server,
    opts,
    "list_connections",
    "List active relationships (other Agent Names you are connected to). These are people, not AI clients.",
    z.object({}),
    true,
  );
  tool(
    server,
    opts,
    "get_relationship_permissions",
    "Get directional relationship permissions between you and another Agent Name.",
    z.object({
      agent_name: z.string().min(1).describe("Other Agent Name, example @daniel"),
    }),
    true,
  );
  tool(
    server,
    opts,
    "set_relationship_permissions",
    "Set the permissions you grant another Agent Name (messaging, scheduling, negotiation). Missing permission is deny. Does not change permissions they grant you.",
    z.object({
      agent_name: z.string().min(1).describe("Other Agent Name, example @daniel"),
      messaging: z.boolean().optional(),
      scheduling: z.boolean().optional(),
      negotiation: z.boolean().optional(),
    }),
  );

  tool(
    server,
    opts,
    "create_interaction",
    "Create a COORDINATE interaction to another Agent Name. Backend enforces messaging permission.",
    z.object({
      to: z.string().min(1).describe("Recipient Agent Name, example @daniel"),
      intent: z.string().min(1).describe("What you want to coordinate"),
      type: z.string().optional().describe("Must be COORDINATE in Phase 1"),
      constraints: z.record(z.string(), z.unknown()).optional(),
    }),
  );
  tool(
    server,
    opts,
    "list_pending_interactions",
    "List your actionable inbox, including items that need a proposal or approval. Archived items are omitted.",
    z.object({}),
    true,
  );
  tool(
    server,
    opts,
    "get_interaction",
    "Get one interaction you participate in, including TIME proposals and approval requests.",
    z.object({
      interaction_id: z.string().min(1),
    }),
    true,
  );
  tool(
    server,
    opts,
    "respond_to_interaction",
    "Claim the inbox item and move a PENDING interaction to IN_PROGRESS. Optional; create_proposal can claim instead.",
    z.object({
      interaction_id: z.string().min(1),
    }),
  );

  tool(
    server,
    opts,
    "create_proposal",
    "Propose a TIME on an interaction. Backend enforces scheduling permission and claims the work atomically. Moves the interaction to AWAITING_OWNER.",
    z.object({
      interaction_id: z.string().min(1),
      type: z.string().optional().describe("Must be TIME in Phase 1"),
      start: z.string().optional().describe("ISO start time"),
      end: z.string().optional().describe("ISO end time"),
      timezone: z.string().optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
    }),
  );
  tool(
    server,
    opts,
    "approve_proposal",
    "Approve a TIME proposal. Transactional: proposal ACCEPTED, interaction AGREED. Idempotent if already approved.",
    z.object({
      proposal_id: z.string().min(1),
    }),
  );
  tool(
    server,
    opts,
    "reject_proposal",
    "Reject a TIME proposal. Transactional: proposal REJECTED, interaction returns to IN_PROGRESS.",
    z.object({
      proposal_id: z.string().min(1),
    }),
  );

  tool(
    server,
    opts,
    "list_agent_connections",
    "List AI connections authorized to represent your Agent Name (Claude, ChatGPT, OpenClaw, etc.). Agent Name stays the same; these are representatives, not the identity.",
    z.object({}),
    true,
  );
  const revokeDescription =
    "Revoke one AI connection so it can no longer represent your Agent Name. Does not delete your Agent Name, account, relationships, or other AI connections. Intended production UX: confirm in the browser before revoke. This tool is the backend capability for testing.";
  tool(
    server,
    opts,
    "revoke_agent_connection",
    revokeDescription,
    z.object({
      agent_connection_id: z
        .string()
        .optional()
        .describe("Connection id from list_agent_connections, or 'current' for this Claude/grant"),
    }),
  );
  tool(
    server,
    opts,
    "request_disconnect_agent",
    "Alias of revoke_agent_connection. " + revokeDescription,
    z.object({
      agent_connection_id: z.string().optional(),
    }),
  );

  return server;
}
