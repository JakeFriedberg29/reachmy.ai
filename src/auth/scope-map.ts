/**
 * Proposed tool→scope mapping for Slice 6a report-only evaluation. Not enforced until Slice 6b.
 * See Phase 3.5 plan §5.
 */
export const TOOL_REQUIRED_SCOPES: Record<string, string> = {
  get_my_identity: "identity:read",
  get_identity: "identity:read",
  create_identity: "identity:write",
  resolve_identity: "identity:read",
  create_invite: "contacts:write",
  accept_invite: "contacts:write",
  list_connections: "contacts:read",
  get_relationship_permissions: "contacts:read",
  set_relationship_permissions: "contacts:write",
  create_interaction: "interactions:write",
  list_pending_interactions: "interactions:read",
  get_interaction: "interactions:read",
  respond_to_interaction: "interactions:write",
  create_proposal: "proposals:write",
  approve_proposal: "approvals:write",
  reject_proposal: "approvals:write",
  list_agent_connections: "identity:read",
  request_disconnect_agent: "identity:write",
  revoke_agent_connection: "identity:write",
};

export const ALL_MCP_TOOLS = Object.keys(TOOL_REQUIRED_SCOPES);

export function parseScopeString(scope: string | null | undefined): string[] {
  return typeof scope === "string" ? scope.split(" ").filter(Boolean) : [];
}

export function evaluateToolScope(
  tool: string,
  grantedScopes: readonly string[],
): { requiredScope: string | null; wouldDeny: boolean } {
  const requiredScope = TOOL_REQUIRED_SCOPES[tool] ?? null;
  if (!requiredScope) return { requiredScope: null, wouldDeny: false };
  return { requiredScope, wouldDeny: !grantedScopes.includes(requiredScope) };
}
