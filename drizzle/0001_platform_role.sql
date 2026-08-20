ALTER TABLE "accounts" ADD COLUMN "platform_role" text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_platform_role_chk" CHECK ("platform_role" IN ('user', 'admin'));
