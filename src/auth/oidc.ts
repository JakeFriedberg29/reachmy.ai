import type { IncomingMessage, ServerResponse } from "node:http";
import Provider, { type AdapterConstructor } from "oidc-provider";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/client.js";
import type { SigningJwks } from "../db/jwks.js";
import { ensureProvisionalPrincipal, getIdentityByAccountId } from "../domain/identity.js";

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
type Interaction = Awaited<ReturnType<Provider["interactionDetails"]>>;

function applyRequestedGrant(grant: Grant, details: Interaction, defaultResource: string): void {
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

  const resourceParam = details.params.resource;
  const resources = Array.isArray(resourceParam)
    ? resourceParam.map(String)
    : resourceParam
      ? [String(resourceParam)]
      : [];
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
    clients: [
      {
        client_id: "phase-minus1-cli",
        client_secret: "phase-minus1-cli-secret",
        token_endpoint_auth_method: "none",
        redirect_uris: [`${config.publicUrl}/dev/callback`],
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        scope: SCOPES,
      },
    ],
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
  applyRequestedGrant(grant, details, mcpResource(config.publicUrl));
  const savedGrantId = await grant.save();

  const result: {
    login?: { accountId: string };
    consent: { grantId: string };
  } = {
    consent: { grantId: savedGrantId },
  };
  if (prompt.name === "login" || !session?.accountId) {
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