import type { OidcInteraction } from "./oidc.js";
import { logOauth } from "./oidc.js";
import { parseScopeString } from "./scope-map.js";

export type ScopeFlowKind = "initial_authorization" | "reauthorization" | "refresh";

export type ScopeAuthorizationObservation = {
  client_id: string;
  client_name: string | null;
  redirect_host: string | null;
  flow_kind: Exclude<ScopeFlowKind, "refresh">;
  prompt_name: string;
  grant_id: string | null;
  requested_scopes: string[];
  granted_oidc_scopes: string[];
  granted_resource_scopes: Record<string, string[]>;
  scope_expanded: boolean;
};

const SENSITIVE_LOG_KEYS =
  /^(access_token|refresh_token|authorization_code|code_verifier|code_challenge|client_secret|cookie|set-cookie|an_session|_session|_interaction)$/i;

const CORRELATION_KEYS = new Set(["client_id", "grant_id"]);

export function assertScopeObservationSafe(fields: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_LOG_KEYS.test(key)) {
      throw new Error(`scope observation must not log sensitive field: ${key}`);
    }
    if (
      !CORRELATION_KEYS.has(key) &&
      typeof value === "string" &&
      value.length > 40 &&
      /^[A-Za-z0-9_-]{40,}$/.test(value)
    ) {
      throw new Error(`scope observation must not log token-like value for field: ${key}`);
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assertScopeObservationSafe(value as Record<string, unknown>);
    }
  }
}

export function classifyAuthorizationFlow(details: OidcInteraction): Exclude<ScopeFlowKind, "refresh"> {
  return details.grantId ? "reauthorization" : "initial_authorization";
}

export function scopesExpanded(requested: readonly string[], granted: readonly string[]): boolean {
  const requestedSet = new Set(requested);
  return granted.some((scope) => !requestedSet.has(scope));
}

type GrantScopeReader = {
  getOIDCScope(): string;
  getResourceScope(resource: string): string;
};

export function readGrantedScopes(
  grant: GrantScopeReader,
  resources: string[],
): { oidc: string[]; resource: Record<string, string[]> } {
  const oidc = parseScopeString(grant.getOIDCScope());
  const resource: Record<string, string[]> = {};
  for (const indicator of resources) {
    resource[indicator] = parseScopeString(grant.getResourceScope(indicator));
  }
  return { oidc, resource };
}

export function buildScopeAuthorizationObservation(input: {
  details: OidcInteraction;
  grant: GrantScopeReader;
  clientName: string | null;
  redirectHost: string | null;
  resourceIndicators: string[];
}): ScopeAuthorizationObservation {
  const requestedScopes = parseScopeString(
    typeof input.details.params.scope === "string" ? input.details.params.scope : null,
  );
  const granted = readGrantedScopes(input.grant, input.resourceIndicators);
  const allGranted = [...granted.oidc, ...Object.values(granted.resource).flat()];
  return {
    client_id: String(input.details.params.client_id ?? ""),
    client_name: input.clientName,
    redirect_host: input.redirectHost,
    flow_kind: classifyAuthorizationFlow(input.details),
    prompt_name: input.details.prompt.name,
    grant_id: input.details.grantId ?? null,
    requested_scopes: requestedScopes,
    granted_oidc_scopes: granted.oidc,
    granted_resource_scopes: granted.resource,
    scope_expanded: scopesExpanded(requestedScopes, allGranted),
  };
}

export function logScopeAuthorization(observation: ScopeAuthorizationObservation): void {
  assertScopeObservationSafe(observation as unknown as Record<string, unknown>);
  logOauth("scope_authorization_observed", observation as unknown as Record<string, unknown>);
}

export function logScopeTokenIssuance(fields: {
  flow_kind: "authorization_code" | "refresh";
  client_id: string;
  grant_id: string | null;
  token_scopes: string[];
}): void {
  assertScopeObservationSafe(fields as unknown as Record<string, unknown>);
  logOauth("scope_token_observed", fields as unknown as Record<string, unknown>);
}

export function logScopeMcpWouldDeny(fields: {
  tool: string;
  required_scope: string;
  granted_scopes: string[];
  client_id: string | null;
  grant_id: string | null;
}): void {
  assertScopeObservationSafe(fields as unknown as Record<string, unknown>);
  logOauth("scope_mcp_would_deny", fields as unknown as Record<string, unknown>);
}
