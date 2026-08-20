import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: citext("email"),
    clerkUserId: text("clerk_user_id").notNull().unique(),
    platformRole: text("platform_role").notNull().default("user"),
    ...timestamps,
  },
  (t) => [check("accounts_platform_role_chk", sql`${t.platformRole} in ('user', 'admin')`)],
);

export const principals = pgTable("principals", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .unique()
    .references(() => accounts.id),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("active"),
  ...timestamps,
});

export const handles = pgTable(
  "handles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .unique()
      .references(() => principals.id),
    handle: citext("handle").notNull().unique(),
    ...timestamps,
  },
  (t) => [index("handles_handle_idx").on(t.handle)],
);

export const agentConnections = pgTable(
  "agent_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id),
    grantId: text("grant_id"),
    oauthClientId: text("oauth_client_id"),
    provider: text("provider"),
    displayLabel: text("display_label").notNull().default("Agent"),
    status: text("status").notNull().default("connected"),
    isPrimary: boolean("is_primary").notNull().default(false),
    capabilities: jsonb("capabilities")
      .$type<{ inbox_available?: boolean; push_reachable?: boolean }>()
      .notNull()
      .default({}),
    lastAuthorizedAt: timestamp("last_authorized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_connections_grant_uidx")
      .on(t.principalId, t.grantId)
      .where(sql`${t.grantId} is not null`),
    uniqueIndex("agent_connections_client_uidx")
      .on(t.principalId, t.oauthClientId)
      .where(sql`${t.oauthClientId} is not null`),
    uniqueIndex("agent_connections_primary_uidx")
      .on(t.principalId)
      .where(sql`${t.isPrimary} and ${t.status} = 'connected'`),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    inviterPrincipalId: uuid("inviter_principal_id")
      .notNull()
      .references(() => principals.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    consumedByPrincipalId: uuid("consumed_by_principal_id").references(() => principals.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("invites_inviter_idx").on(t.inviterPrincipalId)],
);

export const relationships = pgTable(
  "relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalLowId: uuid("principal_low_id")
      .notNull()
      .references(() => principals.id),
    principalHighId: uuid("principal_high_id")
      .notNull()
      .references(() => principals.id),
    status: text("status").notNull().default("active"),
    ...timestamps,
  },
  (t) => [uniqueIndex("relationships_pair_uidx").on(t.principalLowId, t.principalHighId)],
);

export const relationshipPermissions = pgTable(
  "relationship_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    relationshipId: uuid("relationship_id")
      .notNull()
      .references(() => relationships.id),
    grantorPrincipalId: uuid("grantor_principal_id")
      .notNull()
      .references(() => principals.id),
    granteePrincipalId: uuid("grantee_principal_id")
      .notNull()
      .references(() => principals.id),
    messaging: boolean("messaging").notNull().default(false),
    scheduling: boolean("scheduling").notNull().default(false),
    negotiation: boolean("negotiation").notNull().default(false),
    purchases: text("purchases").notNull().default("deny"),
    financialInfo: text("financial_info").notNull().default("deny"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("relationship_permissions_dir_uidx").on(
      t.relationshipId,
      t.grantorPrincipalId,
      t.granteePrincipalId,
    ),
  ],
);

export const blocks = pgTable(
  "blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    blockerPrincipalId: uuid("blocker_principal_id")
      .notNull()
      .references(() => principals.id),
    blockedPrincipalId: uuid("blocked_principal_id")
      .notNull()
      .references(() => principals.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("blocks_pair_uidx").on(t.blockerPrincipalId, t.blockedPrincipalId)],
);

export const interactions = pgTable("interactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(),
  intent: text("intent").notNull(),
  status: text("status").notNull().default("PENDING"),
  constraints: jsonb("constraints"),
  initiatorPrincipalId: uuid("initiator_principal_id")
    .notNull()
    .references(() => principals.id),
  recipientPrincipalId: uuid("recipient_principal_id")
    .notNull()
    .references(() => principals.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  ...timestamps,
});

export const interactionEvents = pgTable(
  "interaction_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id),
    type: text("type").notNull(),
    actorPrincipalId: uuid("actor_principal_id").references(() => principals.id),
    agentConnectionId: uuid("agent_connection_id").references(() => agentConnections.id),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("interaction_events_interaction_idx").on(t.interactionId)],
);

export const interactionMessages = pgTable("interaction_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  interactionId: uuid("interaction_id")
    .notNull()
    .references(() => interactions.id),
  authorPrincipalId: uuid("author_principal_id")
    .notNull()
    .references(() => principals.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inboxItems = pgTable(
  "inbox_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id),
    assigneeAgentConnectionId: uuid("assignee_agent_connection_id").references(
      () => agentConnections.id,
    ),
    claimedByAgentConnectionId: uuid("claimed_by_agent_connection_id").references(
      () => agentConnections.id,
    ),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    state: text("state").notNull().default("unread"),
    ...timestamps,
  },
  (t) => [uniqueIndex("inbox_items_principal_interaction_uidx").on(t.principalId, t.interactionId)],
);

export const proposals = pgTable("proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  interactionId: uuid("interaction_id")
    .notNull()
    .references(() => interactions.id),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: text("status").notNull().default("PROPOSED"),
  proposedByPrincipalId: uuid("proposed_by_principal_id")
    .notNull()
    .references(() => principals.id),
  ...timestamps,
});

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id),
    interactionId: uuid("interaction_id")
      .notNull()
      .references(() => interactions.id),
    approverPrincipalId: uuid("approver_principal_id")
      .notNull()
      .references(() => principals.id),
    status: text("status").notNull().default("pending"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByPrincipalId: uuid("resolved_by_principal_id").references(() => principals.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("approval_requests_one_pending_uidx")
      .on(t.interactionId)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export const emailOutbox = pgTable("email_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  toEmail: text("to_email").notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorPrincipalId: uuid("actor_principal_id").references(() => principals.id),
  agentConnectionId: uuid("agent_connection_id").references(() => agentConnections.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const asSigningKeys = pgTable("as_signing_keys", {
  id: text("id").primaryKey(),
  jwks: jsonb("jwks").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oauthModels = pgTable(
  "oauth_models",
  {
    model: text("model").notNull(),
    id: text("id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    uid: text("uid"),
    grantId: text("grant_id"),
    userCode: text("user_code"),
    consumedAt: integer("consumed_at"),
  },
  (t) => [
    uniqueIndex("oauth_models_pk").on(t.model, t.id),
    index("oauth_models_uid_idx").on(t.model, t.uid),
    index("oauth_models_grant_idx").on(t.grantId),
    index("oauth_models_user_code_idx").on(t.model, t.userCode),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type Principal = typeof principals.$inferSelect;
export type Handle = typeof handles.$inferSelect;
export type AgentConnection = typeof agentConnections.$inferSelect;
export type Interaction = typeof interactions.$inferSelect;
export type InboxItem = typeof inboxItems.$inferSelect;
export type Proposal = typeof proposals.$inferSelect;
export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type Invite = typeof invites.$inferSelect;
export type Relationship = typeof relationships.$inferSelect;
