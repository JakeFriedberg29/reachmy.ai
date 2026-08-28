import type { IncomingMessage, ServerResponse } from "node:http";
import Provider, { errors, type AdapterConstructor } from "oidc-provider";
import { isProductionRuntime, type AppConfig } from "../config.js";
import type { Database } from "../db/client.js";
import type { SigningJwks } from "../db/jwks.js";
import { ensureProvisionalPrincipal, getIdentityByAccountId } from "../domain/identity.js";
import {
  createRateLimiter,
  devStaticClients,
  DCR_RATE_LIMIT,
  validateClientMetadata,
} from "./dcr-policy.js";
import {
  buildScopeAuthorizationObservation,
  logScopeAuthorization,
  logScopeTokenIssuance,
} from "./scope-observability.js";

export const SCOPES =
  "openid identity:read contacts:read contacts:write interactions:read interactions:write proposals:write approvals:write offline_access";

export function mcpResource(publicUrl: string): string {
  return `${publicUrl}/mcp`;
}

export function logOauth(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      msg: "oauth_debug",
      event,
      ts: new Date().toISOString(),
      ...fields,
    }),
  );
}

function cookieFlags(req: IncomingMessage) {
  const cookie = req.headers.cookie ?? "";
  return {
    has_interaction_cookie: cookie.includes("_interaction"),
    has_resume_cookie: cookie.includes("_interaction.op_resume") || cookie.includes("_resume"),
    has_session_cookie: cookie.includes("_session"),
  };
}

type Grant = InstanceType<Provider["Grant"]>;
export type OidcInteraction = Awaited<ReturnType<Provider["interactionDetails"]>>;

/**
 * What the user is shown before authorizing a client. Every field is descriptive: locked
 * principle 13 forbids client metadata from influencing any authorization decision.
 */
export type ConsentSummary = {
  clientId: string;
  clientName: string | null;
  redirectUri: string | null;
  redirectHost: string | null;
  scopes: string[];
  resources: string[];
};

function requestedResources(details: OidcInteraction): string[] {
  const resourceParam = details.params.resource;
  if (Array.isArray(resourceParam)) return resourceParam.map(String);
  return resourceParam ? [String(resourceParam)] : [];
}

export async function summarizeConsent(
  provider: Provider,
  details: OidcInteraction,
): Promise<ConsentSummary> {
  const clientId = String(details.params.client_id ?? "");
  const client = clientId ? await provider.Client.find(clientId) : undefined;
  const redirectUri =
    typeof details.params.redirect_uri === "string" ? details.params.redirect_uri : null;
  let redirectHost: string | null = null;
  if (redirectUri) {
    try {
      redirectHost = new URL(redirectUri).host;
    } catch {
      redirectHost = null;
    }
  }
  const scopeParam = typeof details.params.scope === "string" ? details.params.scope : "";
  return {
    clientId,
    clientName: typeof client?.clientName === "string" ? client.clientName : null,
    redirectUri,
    redirectHost,
    scopes: scopeParam.split(" ").filter(Boolean),
    resources: requestedResources(details),
  };
}

function applyRequestedGrant(grant: Grant, details: OidcInteraction, defaultResource: string): void {
  const promptDetails = details.prompt.details as {
    missingOIDCScope?: string[];
    missingOIDCClaims?: string[];
    missingResourceScopes?: Record<string, string[]>;
  };

  if (promptDetails.missingOIDCScope?.length) {
    grant.addOIDCScope(promptDetails.missingOIDCScope.join(" "));
  }
  if (promptDetails.missingOIDCClaims?.length) {
    grant.addOIDCClaims(promptDetails.missingOIDCClaims);
  }
  if (promptDetails.missingResourceScopes) {
    for (const [indicator, scopes] of Object.entries(promptDetails.missingResourceScopes)) {
      grant.addResourceScope(indicator, scopes.join(" "));
    }
  }

  // Clients that omit `scope` (allowed in OAuth 2.1) would otherwise end up with an
  // empty grant, which oidc-provider rejects as access_denied.
  const paramScope = typeof details.params.scope === "string" ? details.params.scope.trim() : "";
  grant.addOIDCScope(paramScope || SCOPES);

  const resources = requestedResources(details);
  if (!resources.includes(defaultResource)) resources.push(defaultResource);
  for (const indicator of resources) {
    grant.addResourceScope(indicator, SCOPES);
  }
}

function attachRedirectLogger(res: ServerResponse, context: Record<string, unknown>): void {
  res.once("finish", () => {
    if (res.statusCode >= 300 && res.statusCode < 400) {
      const location = res.getHeader("location");
      logOauth("redirect_response_sent", {
        ...context,
        statusCode: res.statusCode,
        location: location ? String(location) : null,
      });
    }
  });
}

export function createOidcProvider(
  config: AppConfig,
  db: Database,
  adapter: AdapterConstructor,
  jwks: SigningJwks,
): Provider {
  const resource = mcpResource(config.publicUrl);
  const https = config.publicUrl.startsWith("https");
  const production = isProductionRuntime(config.publicUrl);
  const registrationLimiter = createRateLimiter(DCR_RATE_LIMIT);
  const provider = new Provider(config.publicUrl, {
    adapter,
    jwks,
    cookies: {
      keys: config.cookieKeys,
      short: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: https,
      },
      long: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: https,
      },
    },
    clients: devStaticClients(config.publicUrl, production, SCOPES),
    // A property no client sends, used purely as a hook: oidc-provider passes the whole metadata
    // object to the validator, which is what the redirect-URI and size rules need to see.
    extraClientMetadata: {
      properties: ["reachmy_client_policy"],
      validator: (_ctx, key, _value, metadata) => {
        delete (metadata as Record<string, unknown>)[key];
        const problem = validateClientMetadata(metadata);
        if (!problem) return;
        throw problem.error === "invalid_redirect_uri"
          ? new errors.InvalidRedirectUri(problem.description)
          : new errors.InvalidClientMetadata(problem.description);
      },
    },
    pkce: {
      required: () => true,
    },
    scopes: SCOPES.split(" "),
    claims: {
      openid: ["sub"],
    },
    ttl: {
      AccessToken: 300,
      AuthorizationCode: 600,
      Interaction: 3600,
      Session: 86400 * 7,
      Grant: 86400 * 14,
      RefreshToken: 86400 * 14,
    },
    rotateRefreshToken: true,
    issueRefreshToken: async () => true,
    features: {
      devInteractions: { enabled: false },
      rpInitiatedLogout: { enabled: true },
      revocation: { enabled: true },
      introspection: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        getResourceServerInfo: (_ctx, indicator) => {
          logOauth("resource_server_info", { indicator });
          return {
            scope: SCOPES,
            audience: indicator,
            accessTokenFormat: "jwt",
            jwt: {
              sign: { alg: "RS256" as const },
            },
          };
        },
        useGrantedResource: () => true,
      },
      registration: {
        enabled: true,
        initialAccessToken: false,
      },
      clientCredentials: { enabled: false },
    },
    clientDefaults: {
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      id_token_signed_response_alg: "RS256",
      scope: SCOPES,
    },
    routes: {
      authorization: "/auth",
      token: "/token",
      jwks: "/jwks",
      revocation: "/token/revocation",
      introspection: "/token/introspection",
      registration: "/reg",
    },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    findAccount: async (_ctx, id) => ({
      accountId: id,
      claims: async () => ({ sub: id }),
    }),
    extraTokenClaims: async (_ctx, token) => {
      const accountId = "accountId" in token ? String(token.accountId ?? "") : "";
      if (!accountId) return undefined;
      try {
        const identity = await getIdentityByAccountId(db, accountId);
        const extra: Record<string, string> = {};
        if (identity.principal_id) extra.principal_id = identity.principal_id;
        if ("grantId" in token && token.grantId) extra.grant_id = String(token.grantId);
        return extra;
      } catch {
        return undefined;
      }
    },
  });

  provider.proxy = true;

  // Registration stays open, so the only cost control is volume. Answer over budget with an
  // OAuth-shaped body rather than letting the request reach the adapter.
  provider.use(async (ctx, next) => {
    if (ctx.method === "POST" && ctx.path === "/reg") {
      const key = ctx.ip || "unknown";
      if (!registrationLimiter.allow(key)) {
        logOauth("dcr_rate_limited", { ip: key });
        ctx.status = 429;
        ctx.set("retry-after", String(Math.ceil(DCR_RATE_LIMIT.windowMs / 1000)));
        ctx.body = {
          error: "temporarily_unavailable",
          error_description: "Too many client registrations from this address. Try again later.",
        };
        return;
      }
    }
    await next();
  });

  // OAuth 2.1 clients may omit `scope`. oidc-provider then rejects the request with
  // access_denied ("no scope was granted") before consent runs, so default it here.
  provider.use(async (ctx, next) => {
    if (ctx.method === "GET" && ctx.path === "/auth" && !ctx.query.scope) {
      logOauth("scope_defaulted", { path: ctx.path, applied: SCOPES });
      ctx.query = { ...ctx.query, scope: SCOPES };
    }
    await next();
  });

  provider.on("server_error", (_ctx, error) => {
    logOauth("server_error", { message: String(error), stack: error instanceof Error ? error.stack : undefined });
  });
  provider.on("authorization.error", (_ctx, error) => {
    logOauth("authorization_error", { message: String(error) });
  });
  provider.on("interaction.started", (_ctx, prompt) => {
    logOauth("interaction_started", {
      prompt: (prompt as { name?: string }).name,
      reasons: (prompt as { reasons?: string[] }).reasons,
    });
  });
  provider.on("authorization.accepted", () => {
    logOauth("authorization_accepted", {});
  });
  provider.on("authorization.success", () => {
    logOauth("authorization_success", {});
  });
  provider.on("authorization_code.saved", (code) => {
    logOauth("authorization_code_generated", {
      client_id: code.clientId,
      redirect_uri: code.redirectUri,
      grant_id: code.grantId,
      account_id: code.accountId,
      has_code_challenge: Boolean(code.codeChallenge),
      code_challenge_method: code.codeChallengeMethod ?? null,
    });
  });
  provider.on("registration_create.success", (_ctx, client) => {
    logOauth("dcr_client_created", {
      client_id: client.clientId,
      redirect_uris: client.redirectUris,
      application_type: client.applicationType,
      grant_types: client.grantTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    });
  });

  // Report-only: record scopes placed into issued access tokens (authorization code + refresh).
  provider.use(async (ctx, next) => {
    await next();
    if (ctx.method !== "POST" || ctx.path !== "/token" || ctx.status !== 200) return;
    const grantType = ctx.oidc?.params?.grant_type;
    if (grantType !== "authorization_code" && grantType !== "refresh_token") return;
    const accessToken = ctx.oidc?.entities?.AccessToken;
    if (!accessToken) return;
    logScopeTokenIssuance({
      flow_kind: grantType === "refresh_token" ? "refresh" : "authorization_code",
      client_id: String(accessToken.clientId ?? ""),
      grant_id: typeof accessToken.grantId === "string" ? accessToken.grantId : null,
      token_scopes: String(accessToken.scope ?? "")
        .split(" ")
        .filter(Boolean),
    });
  });

  return provider;
}

export async function completeOauthInteraction(
  provider: Provider,
  config: AppConfig,
  db: Database,
  req: IncomingMessage,
  res: ServerResponse,
  accountId: string,
): Promise<void> {
  await ensureProvisionalPrincipal(db, accountId);
  const details = await provider.interactionDetails(req, res);
  const { prompt, params, session, uid, grantId, returnTo } = details;
  const clientId = String(params.client_id ?? "");
  const redirectUri = typeof params.redirect_uri === "string" ? params.redirect_uri : null;
  const client = clientId ? await provider.Client.find(clientId) : undefined;
  const registeredRedirects = client?.redirectUris ?? [];
  void config;

  logOauth("interaction_details", {
    method: req.method,
    path: req.url,
    uid,
    prompt: prompt.name,
    reasons: prompt.reasons,
    prompt_details: prompt.details,
    client_id: clientId,
    redirect_uri: redirectUri,
    registered_redirect_uris: registeredRedirects,
    redirect_uri_allowed: redirectUri ? registeredRedirects.includes(redirectUri) : null,
    application_type: client?.applicationType ?? null,
    scope: params.scope ?? null,
    resource: params.resource ?? null,
    has_code_challenge: Boolean(params.code_challenge),
    code_challenge_method: params.code_challenge_method ?? null,
    grant_id: grantId ?? null,
    session_account_id: session?.accountId ?? null,
    return_to: returnTo,
    ...cookieFlags(req),
  });

  let grant: Grant;
  if (grantId) {
    const existing = await provider.Grant.find(grantId);
    grant = existing ?? new provider.Grant({ accountId, clientId });
  } else {
    grant = new provider.Grant({ accountId, clientId });
  }
  const defaultResource = mcpResource(config.publicUrl);
  const resources = requestedResources(details);
  if (!resources.includes(defaultResource)) resources.push(defaultResource);
  applyRequestedGrant(grant, details, defaultResource);

  let redirectHost: string | null = null;
  if (redirectUri) {
    try {
      redirectHost = new URL(redirectUri).host;
    } catch {
      redirectHost = null;
    }
  }
  logScopeAuthorization(
    buildScopeAuthorizationObservation({
      details,
      grant,
      clientName: typeof client?.clientName === "string" ? client.clientName : null,
      redirectHost,
      resourceIndicators: resources,
    }),
  );

  const savedGrantId = await grant.save();

  const result: {
    login?: { accountId: string };
    consent: { grantId: string };
  } = {
    consent: { grantId: savedGrantId },
  };
  // Re-assert the login when the provider session is absent or bound to a different subject, so
  // the grant can never be issued against an account other than the one that just consented.
  if (prompt.name === "login" || session?.accountId !== accountId) {
    result.login = { accountId };
  }

  logOauth("consent_accepted", {
    uid,
    prompt: prompt.name,
    grant_id: savedGrantId,
    will_login: Boolean(result.login),
    account_id: accountId,
    redirect_uri: redirectUri,
    resume_url: returnTo,
  });

  attachRedirectLogger(res, {
    uid,
    prompt: prompt.name,
    redirect_uri: redirectUri,
    resume_url: returnTo,
  });

  await provider.interactionFinished(req, res, result, {
    mergeWithLastSubmission: true,
  });
}

export async function denyOauthInteraction(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const details = await provider.interactionDetails(req, res);
  const redirectUri =
    typeof details.params.redirect_uri === "string" ? details.params.redirect_uri : null;

  logOauth("consent_denied", {
    uid: details.uid,
    prompt: details.prompt.name,
    client_id: details.params.client_id ?? null,
    redirect_uri: redirectUri,
    resume_url: details.returnTo,
  });

  attachRedirectLogger(res, { uid: details.uid, prompt: details.prompt.name, redirect_uri: redirectUri });

  await provider.interactionFinished(
    req,
    res,
    {
      error: "access_denied",
      error_description: "The user denied this authorization request.",
    },
    { mergeWithLastSubmission: false },
  );
}