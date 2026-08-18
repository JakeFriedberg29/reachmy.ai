CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE TABLE "accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" citext,
  "clerk_user_id" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "accounts_clerk_user_id_unique" UNIQUE("clerk_user_id")
);
--> statement-breakpoint
CREATE TABLE "principals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "display_name" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "principals_account_id_unique" UNIQUE("account_id"),
  CONSTRAINT "principals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
);
--> statement-breakpoint
CREATE TABLE "handles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "principal_id" uuid NOT NULL,
  "handle" citext NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "handles_principal_id_unique" UNIQUE("principal_id"),
  CONSTRAINT "handles_handle_unique" UNIQUE("handle"),
  CONSTRAINT "handles_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "principals"("id"),
  CONSTRAINT "handles_format_chk" CHECK ("handle" ~ '^[a-z0-9_]{3,30}$')
);
--> statement-breakpoint
CREATE TABLE "agent_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "principal_id" uuid NOT NULL,
  "grant_id" text,
  "oauth_client_id" text,
  "provider" text,
  "display_label" text DEFAULT 'Agent' NOT NULL,
  "status" text DEFAULT 'connected' NOT NULL,
  "is_primary" boolean DEFAULT false NOT NULL,
  "capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_authorized_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "agent_connections_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "principals"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_connections_grant_uidx"
  ON "agent_connections" ("principal_id", "grant_id")
  WHERE "grant_id" IS NOT NULL;
CREATE UNIQUE INDEX "agent_connections_client_uidx"
  ON "agent_connections" ("principal_id", "oauth_client_id")
  WHERE "oauth_client_id" IS NOT NULL;
CREATE UNIQUE INDEX "agent_connections_primary_uidx"
  ON "agent_connections" ("principal_id")
  WHERE "is_primary" AND "status" = 'connected';
--> statement-breakpoint
CREATE TABLE "invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" text NOT NULL,
  "inviter_principal_id" uuid NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "consumed_by_principal_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash"),
  CONSTRAINT "invites_inviter_principal_id_principals_id_fk" FOREIGN KEY ("inviter_principal_id") REFERENCES "principals"("id"),
  CONSTRAINT "invites_consumed_by_principal_id_principals_id_fk" FOREIGN KEY ("consumed_by_principal_id") REFERENCES "principals"("id")
);
--> statement-breakpoint
CREATE TABLE "relationships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "principal_low_id" uuid NOT NULL,
  "principal_high_id" uuid NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "relationships_pair_uidx" UNIQUE("principal_low_id", "principal_high_id"),
  CONSTRAINT "relationships_order_chk" CHECK ("principal_low_id" < "principal_high_id"),
  CONSTRAINT "relationships_principal_low_id_principals_id_fk" FOREIGN KEY ("principal_low_id") REFERENCES "principals"("id"),
  CONSTRAINT "relationships_principal_high_id_principals_id_fk" FOREIGN KEY ("principal_high_id") REFERENCES "principals"("id")
);
--> statement-breakpoint
CREATE TABLE "relationship_permissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "relationship_id" uuid NOT NULL,
  "grantor_principal_id" uuid NOT NULL,
  "grantee_principal_id" uuid NOT NULL,
  "messaging" boolean DEFAULT false NOT NULL,
  "scheduling" boolean DEFAULT false NOT NULL,
  "negotiation" boolean DEFAULT false NOT NULL,
  "purchases" text DEFAULT 'deny' NOT NULL,
  "financial_info" text DEFAULT 'deny' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "relationship_permissions_dir_uidx" UNIQUE("relationship_id", "grantor_principal_id", "grantee_principal_id"),
  CONSTRAINT "relationship_permissions_not_self_chk" CHECK ("grantor_principal_id" <> "grantee_principal_id"),
  CONSTRAINT "relationship_permissions_relationship_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "relationships"("id"),
  CONSTRAINT "relationship_permissions_grantor_fk" FOREIGN KEY ("grantor_principal_id") REFERENCES "principals"("id"),
  CONSTRAINT "relationship_permissions_grantee_fk" FOREIGN KEY ("grantee_principal_id") REFERENCES "principals"("id")
);
--> statement-breakpoint
CREATE TABLE "blocks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "blocker_principal_id" uuid NOT NULL,
  "blocked_principal_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "blocks_pair_uidx" UNIQUE("blocker_principal_id", "blocked_principal_id"),
  CONSTRAINT "blocks_blocker_fk" FOREIGN KEY ("blocker_principal_id") REFERENCES "principals"("id"),
  CONSTRAINT "blocks_blocked_fk" FOREIGN KEY ("blocked_principal_id") REFERENCES "principals"("id")
);
--> statement-breakpoint
CREATE TABLE "interactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" text NOT NULL,
  "intent" text NOT NULL,
  "status" text DEFAULT 'PENDING' NOT NULL,
  "constraints" jsonb,
  "initiator_principal_id" uuid NOT NULL,
  "recipient_principal_id" uuid NOT NULL,
  "expires_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "interactions_initiator_fk" FOREIGN KEY ("initiator_principal_id") REFERENCES "principals"("id"),
  CONSTRAINT "interactions_recipient_fk" FOREIGN KEY ("recipient_principal_id") REFERENCES "principals"("id"),
  CONSTRAINT "interactions_not_self_chk" CHECK ("initiator_principal_id" <> "recipient_principal_id")
);
--> statement-breakpoint
CREATE TABLE "interaction_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "interaction_id" uuid NOT NULL,
  "type" text NOT NULL,
  "actor_principal_id" uuid,
  "agent_connection_id" uuid,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "interaction_events_interaction_fk" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id"),
  CONSTRAINT "interaction_events_actor_fk" FOREIGN KEY ("actor_principal_id") REFERENCES "principals"("id"),
  CONSTRAINT "interaction_events_connection_fk" FOREIGN KEY ("agent_connection_id") REFERENCES "agent_connections"("id")
);
--> statement-breakpoint
CREATE TABLE "interaction_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "interaction_id" uuid NOT NULL,
  "author_principal_id" uuid NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "interaction_messages_interaction_fk" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id"),
  CONSTRAINT "interaction_messages_author_fk" FOREIGN KEY ("author_principal_id") REFERENCES "principals"("id")
);
--> statement-breakpoint
CREATE TABLE "inbox_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "principal_id" uuid NOT NULL,
  "interaction_id" uuid NOT NULL,
  "assignee_agent_connection_id" uuid,
  "claimed_by_agent_connection_id" uuid,
  "claimed_at" timestamptz,
  "state" text DEFAULT 'unread' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "inbox_items_principal_interaction_uidx" UNIQUE("principal_id", "interaction_id"),
  CONSTRAINT "inbox_items_principal_fk" FOREIGN KEY ("principal_id") REFERENCES "principals"("id"),
  CONSTRAINT "inbox_items_interaction_fk" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id"),
  CONSTRAINT "inbox_items_assignee_fk" FOREIGN KEY ("assignee_agent_connection_id") REFERENCES "agent_connections"("id"),
  CONSTRAINT "inbox_items_claimed_fk" FOREIGN KEY ("claimed_by_agent_connection_id") REFERENCES "agent_connections"("id")
);
--> statement-breakpoint
CREATE TABLE "proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "interaction_id" uuid NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'PROPOSED' NOT NULL,
  "proposed_by_principal_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "proposals_interaction_fk" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id"),
  CONSTRAINT "proposals_proposed_by_fk" FOREIGN KEY ("proposed_by_principal_id") REFERENCES "principals"("id")
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "proposal_id" uuid NOT NULL,
  "interaction_id" uuid NOT NULL,
  "approver_principal_id" uuid NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "resolved_at" timestamptz,
  "resolved_by_principal_id" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "approval_requests_proposal_fk" FOREIGN KEY ("proposal_id") REFERENCES "proposals"("id"),
  CONSTRAINT "approval_requests_interaction_fk" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id"),
  CONSTRAINT "approval_requests_approver_fk" FOREIGN KEY ("approver_principal_id") REFERENCES "principals"("id"),
  CONSTRAINT "approval_requests_resolved_by_fk" FOREIGN KEY ("resolved_by_principal_id") REFERENCES "principals"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_one_pending_uidx"
  ON "approval_requests" ("interaction_id")
  WHERE "status" = 'pending';
--> statement-breakpoint
CREATE TABLE "email_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "to_email" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_principal_id" uuid,
  "agent_connection_id" uuid,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "audit_logs_actor_fk" FOREIGN KEY ("actor_principal_id") REFERENCES "principals"("id"),
  CONSTRAINT "audit_logs_connection_fk" FOREIGN KEY ("agent_connection_id") REFERENCES "agent_connections"("id")
);
--> statement-breakpoint
CREATE TABLE "as_signing_keys" (
  "id" text PRIMARY KEY NOT NULL,
  "jwks" jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_models" (
  "model" text NOT NULL,
  "id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "expires_at" timestamptz,
  "uid" text,
  "grant_id" text,
  "user_code" text,
  "consumed_at" integer,
  CONSTRAINT "oauth_models_pk" UNIQUE("model", "id")
);
--> statement-breakpoint
CREATE INDEX "handles_handle_idx" ON "handles" ("handle");
CREATE INDEX "invites_inviter_idx" ON "invites" ("inviter_principal_id");
CREATE INDEX "interaction_events_interaction_idx" ON "interaction_events" ("interaction_id");
CREATE INDEX "oauth_models_uid_idx" ON "oauth_models" ("model", "uid");
CREATE INDEX "oauth_models_grant_idx" ON "oauth_models" ("grant_id");
CREATE INDEX "oauth_models_user_code_idx" ON "oauth_models" ("model", "user_code");
