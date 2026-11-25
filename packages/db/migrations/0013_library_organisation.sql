CREATE TYPE "public"."highlight_color" AS ENUM('yellow', 'green', 'blue', 'pink');--> statement-breakpoint
CREATE TABLE "collection_sources" (
	"workspace_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_sources_pkey" PRIMARY KEY("collection_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "collection_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "collections_name_length" CHECK (char_length(btrim("collections"."name")) between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "collections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "highlights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"quote" text NOT NULL,
	"note" text,
	"color" "highlight_color" DEFAULT 'yellow' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "highlights_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "highlights_offsets_valid" CHECK ("highlights"."char_start" >= 0 and "highlights"."char_end" > "highlights"."char_start"),
	CONSTRAINT "highlights_quote_matches_offsets" CHECK (char_length("highlights"."quote") = "highlights"."char_end" - "highlights"."char_start"),
	CONSTRAINT "highlights_note_length" CHECK ("highlights"."note" is null or char_length("highlights"."note") <= 5000)
);
--> statement-breakpoint
ALTER TABLE "highlights" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "collection_sources" ADD CONSTRAINT "collection_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_sources" ADD CONSTRAINT "collection_sources_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_sources" ADD CONSTRAINT "collection_sources_collection_fk" FOREIGN KEY ("workspace_id","collection_id") REFERENCES "public"."collections"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_sources" ADD CONSTRAINT "collection_sources_source_fk" FOREIGN KEY ("workspace_id","source_id") REFERENCES "public"."sources"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "highlights" ADD CONSTRAINT "highlights_chunk_fk" FOREIGN KEY ("workspace_id","chunk_id") REFERENCES "public"."chunks"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_sources_source_id_idx" ON "collection_sources" USING btree ("workspace_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_project_id_name_key" ON "collections" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE INDEX "collections_project_id_idx" ON "collections" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "highlights_project_id_idx" ON "highlights" USING btree ("workspace_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "highlights_chunk_id_idx" ON "highlights" USING btree ("workspace_id","chunk_id");--> statement-breakpoint
CREATE POLICY "collection_sources_tenant_isolation" ON "collection_sources" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "collections_tenant_isolation" ON "collections" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "highlights_tenant_isolation" ON "highlights" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- Hand-written: privileges and forced RLS, as for every tenant table (see 0002_security).
-- Collections and highlights are the researcher's own organisation of the library, so
-- they may be deleted; membership rows are added and removed, never updated.
GRANT SELECT, INSERT, UPDATE, DELETE ON collections TO bahith_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON collection_sources TO bahith_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON highlights TO bahith_app;--> statement-breakpoint
ALTER TABLE collections FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE collection_sources FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE highlights FORCE ROW LEVEL SECURITY;
