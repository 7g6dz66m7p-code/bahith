CREATE TYPE "public"."document_comment_kind" AS ENUM('comment', 'suggestion');--> statement-breakpoint
CREATE TYPE "public"."document_comment_status" AS ENUM('open', 'resolved', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "document_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" "document_comment_kind" NOT NULL,
	"status" "document_comment_status" DEFAULT 'open' NOT NULL,
	"anchor" jsonb NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"suggestion" jsonb,
	"author_id" uuid,
	"author_name" text DEFAULT '' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"applied_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_comments_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "document_comments_body_length" CHECK (char_length("document_comments"."body") <= 5000),
	CONSTRAINT "document_comments_author_name_length" CHECK (char_length("document_comments"."author_name") <= 200),
	CONSTRAINT "document_comments_suggestion_kind" CHECK (("document_comments"."kind" = 'suggestion') = ("document_comments"."suggestion" is not null)),
	CONSTRAINT "document_comments_status_kind" CHECK ("document_comments"."status" in ('open', 'resolved') or "document_comments"."kind" = 'suggestion'),
	CONSTRAINT "document_comments_closed_at" CHECK (("document_comments"."status" = 'open') = ("document_comments"."resolved_at" is null)),
	CONSTRAINT "document_comments_applied_version" CHECK (("document_comments"."status" = 'accepted') = ("document_comments"."applied_version" is not null))
);
--> statement-breakpoint
ALTER TABLE "document_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "public"."documents"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_comments_document_id_idx" ON "document_comments" USING btree ("workspace_id","document_id","created_at");--> statement-breakpoint
CREATE POLICY "document_comments_tenant_isolation" ON "document_comments" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- Hand-written: privileges and forced RLS, as for every tenant table (see 0002_security).
-- The review trail is kept: no DELETE (comments go only with their document, by cascade).
GRANT SELECT, INSERT, UPDATE ON document_comments TO bahith_app;--> statement-breakpoint
ALTER TABLE document_comments FORCE ROW LEVEL SECURITY;
