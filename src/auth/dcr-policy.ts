import type { ClientMetadata } from "oidc-provider";

export const DEV_CLI_CLIENT_ID = "phase-minus1-cli";

/**
 * The Phase -1 CLI client exists to drive `/dev/callback` during local spikes. It has no secret
 * and never had a production purpose, so production ships without it.
 */
export function devStaticClients(
  publicUrl: string,
  production: boolean,
  scope: string,
): ClientMetadata[] {
  if (production) return [];
  return [
    {
      client_id: DEV_CLI_CLIENT_ID,
      client_secret: "phase-minus1-cli-secret",
      token_endpoint_auth_method: "none",
      redirect_uris: [`${publicUrl}/dev/callback`],
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      scope,
    },
  ];
}
