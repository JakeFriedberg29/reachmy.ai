import { and, eq, inArray } from "drizzle-orm";
import type { Database, Tx } from "../db/client.js";
import { oauthModels } from "../db/schema.js";
import { getIdentityByAccountId, isApiConnection, listConnections } from "./identity.js";
import { formatAgentName } from "./types.js";

export type PortalProvider = "claude" | "chatgpt";

export type PortalConnectionStatus = "connected" | "not_connected";

export type PortalConnectionRow = {
  provider: PortalProvider;
  label: string;
  status: PortalConnectionStatus;
};

export type PortalOverview = {
  agent_name: string | null;
  agent_name_status: "claimed" | "not_claimed";
  connections: PortalConnectionRow[];
};

export type PortalAiConnectionsView = {
  overview: PortalOverview;
  /** Server-side only — never sent to the browser (Slice 8 disconnect). */
  connectionIdsByProvider: Record<PortalProvider, string[]>;
};

const PORTAL_PROVIDERS: PortalProvider[] = ["claude", "chatgpt"];

const PROVIDER_LABELS: Record<PortalProvider, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
};

function disconnectedRows(): PortalConnectionRow[] {
  return PORTAL_PROVIDERS.map((provider) => ({
    provider,
    label: PROVIDER_LABELS[provider],
    status: "not_connected",
  }));
}

function emptyConnectionIds(): Record<PortalProvider, string[]> {
  return { claude: [], chatgpt: [] };
}

type OauthClientInferenceInput = {
  client_name?: string | null;
  redirect_uris?: string[] | null;
};

/** Descriptive read helper only — never used for authorization. */
export function inferPortalProvider(input: OauthClientInferenceInput): PortalProvider | null {
  const name = input.client_name?.trim().toLowerCase() ?? "";
  if (name === "claude") return "claude";
  if (name === "chatgpt") return "chatgpt";

  for (const uri of input.redirect_uris ?? []) {
    try {
      const host = new URL(uri).hostname.toLowerCase();
      if (host === "claude.ai" || host.endsWith(".claude.ai")) return "claude";
      if (host === "chatgpt.com" || host.endsWith(".chatgpt.com")) return "chatgpt";
    } catch {
      // Ignore malformed redirect URIs.
    }
  }
  return null;
}

async function loadOauthClientPayloads(
  db: Database | Tx,
  clientIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const unique = [...new Set(clientIds.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const rows = await db
    .select()
    .from(oauthModels)
    .where(and(eq(oauthModels.model, "Client"), inArray(oauthModels.id, unique)));

  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    map.set(row.id, row.payload);
  }
  return map;
}

function payloadInference(payload: Record<string, unknown> | undefined): PortalProvider | null {
  if (!payload) return null;
  const redirectUris = Array.isArray(payload.redirect_uris)
    ? payload.redirect_uris.filter((value): value is string => typeof value === "string")
    : null;
  return inferPortalProvider({
    client_name: typeof payload.client_name === "string" ? payload.client_name : null,
    redirect_uris: redirectUris,
  });
}

/**
 * Read-only Portal connection view for the authenticated account.
 * All rows are scoped to that account's principal before provider inference runs.
 */
export async function listPortalAiConnections(
  db: Database | Tx,
  accountId: string,
): Promise<PortalAiConnectionsView> {
  const identity = await getIdentityByAccountId(db, accountId);
  const overview: PortalOverview = {
    agent_name: identity.handle ? formatAgentName(identity.handle) : null,
    agent_name_status: identity.handle ? "claimed" : "not_claimed",
    connections: disconnectedRows(),
  };
  const connectionIdsByProvider = emptyConnectionIds();

  if (!identity.principal_id) {
    return { overview, connectionIdsByProvider };
  }

  const aiConnections = (await listConnections(db, identity.principal_id)).filter(
    (row) => !isApiConnection(row.grantId),
  );
  const clientPayloads = await loadOauthClientPayloads(
    db,
    aiConnections.map((row) => row.oauthClientId).filter((id): id is string => Boolean(id)),
  );

  for (const row of aiConnections) {
    const provider = payloadInference(
      row.oauthClientId ? clientPayloads.get(row.oauthClientId) : undefined,
    );
    if (!provider) continue;

    connectionIdsByProvider[provider].push(row.id);
    if (row.status === "connected") {
      const slot = overview.connections.find((entry) => entry.provider === provider);
      if (slot) slot.status = "connected";
    }
  }

  return { overview, connectionIdsByProvider };
}

export function toPortalOverviewResponse(view: PortalAiConnectionsView): PortalOverview {
  return view.overview;
}
