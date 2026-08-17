import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { VerifiedPrincipal } from "../auth/verify-token.js";
import { createTestItem, listTestItems } from "../store.js";

export function createPhaseMinus1McpServer(principal: VerifiedPrincipal | null) {
  const server = new McpServer({
    name: "reachmy-ai-phase-minus1",
    version: "0.1.0",
  });

  server.registerTool(
    "get_identity",
    {
      description:
        "Return the Agent Network principal mapped from the current OAuth grant. Read-only spike tool.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!principal) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "unauthorized",
                message: "Sign in with Agent Network OAuth first.",
              }),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              account_id: principal.accountId,
              principal_id: principal.principalId,
              handle: principal.handle,
              display_name: principal.displayName,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "create_test_item",
    {
      description: "Write a stub inbox item for the authenticated principal (Phase -1 only).",
      inputSchema: z.object({
        text: z.string().min(1).describe("Text to persist for this principal"),
      }),
    },
    async ({ text }) => {
      if (!principal) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "unauthorized",
                message: "Sign in with Agent Network OAuth first.",
              }),
            },
          ],
          isError: true,
        };
      }
      const item = createTestItem(principal.principalId, text);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              item,
              items: listTestItems(principal.principalId),
            }),
          },
        ],
      };
    },
  );

  return server;
}
