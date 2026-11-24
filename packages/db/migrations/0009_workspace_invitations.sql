CREATE TABLE "workspace_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "membership_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invitations_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_invitations_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "workspace_invitations_role_not_owner" CHECK ("workspace_invitations"."role" <> 'owner'),
	CONSTRAINT "workspace_invitations_email_lower" CHECK ("workspace_invitations"."email" = lower("workspace_invitations"."email")),
	CONSTRAINT "workspace_invitations_token_hash_format" CHECK ("workspace_invitations"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_invitations_single_outcome" CHECK (not ("workspace_invitations"."accepted_at" is not null and "workspace_invitations"."revoked_at" is not null)),
	CONSTRAINT "workspace_invitations_accepted_by" CHECK ("workspace_invitations"."accepted_by" is null or "workspace_invitations"."accepted_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "workspace_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_invitations_workspace_email_idx" ON "workspace_invitations" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE POLICY "workspace_invitations_tenant_isolation" ON "workspace_invitations" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- Invitations are managed by owners through the service; no DELETE (revoked rows stay as a trail).
GRANT SELECT, INSERT, UPDATE ON workspace_invitations TO bahith_app;--> statement-breakpoint
ALTER TABLE workspace_invitations FORCE ROW LEVEL SECURITY;
