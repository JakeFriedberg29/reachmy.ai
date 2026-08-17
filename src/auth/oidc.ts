import type { IncomingMessage, ServerResponse } from "node:http";
import Provider from "oidc-provider";
import type { AppConfig } from "../config.js";
import { MemoryAdapter } from "./memory-adapter.js";

const SCOPES = "identity:read interactions:write offline_access";

export function mcpResource(publicUrl: string): string {
  return `${publicUrl}/mcp`;
}

export function createOidcProvider(config: AppConfig): Provider {
  const resource = mcpResource(config.publicUrl);
  const provider = new Provider(config.publicUrl, {
    adapter: MemoryAdapter,
    cookies: {
      keys: config.cookieKeys,
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
      sub: ["sub"],
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
        getResourceServerInfo: (_ctx, indicator) => ({
          scope: SCOPES,
          audience: indicator,
          accessTokenFormat: "jwt",
          jwt: {
            sign: { alg: "RS256" },
          },
        }),
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
      if ("accountId" in token && token.accountId) {
        return { principal_id: config.testPrincipalId };
      }
      return undefined;
    },
  });

  provider.proxy = true;
  return provider;
}

export async function finishLogin(
  provider: Provider,
  req: IncomingMessage,
  res: ServerResponse,
  accountId: string,
): Promise<void> {
  const details = await provider.interactionDetails(req, res);
  const { params, session, grantId } = details;
  const clientId = String(params.client_id);
  let grant: InstanceType<Provider["Grant"]>;
  if (grantId) {
    const existing = await provider.Grant.find(grantId);
    grant = existing ?? new provider.Grant({ accountId, clientId });
  } else {
    grant = new provider.Grant({ accountId, clientId });
  }
  const resource = mcpResource(String(provider.issuer));
  grant.addOIDCScope("openid offline_access");
  grant.addResourceScope(resource, "identity:read interactions:write offline_access");

  const result = {
    login: { accountId },
    consent: {
      grantId: await grant.save(),
    },
    session: session ? undefined : undefined,
  };
  await provider.interactionFinished(req, res, result, {
    mergeWithLastSubmission: true,
  });
}
