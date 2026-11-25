CREATE TABLE "telegram_links" (
	"telegram_user_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_links_user_id_key" UNIQUE("user_id"),
	CONSTRAINT "telegram_links_id_digits" CHECK ("telegram_links"."telegram_user_id" ~ '^[1-9][0-9]{0,19}$'),
	CONSTRAINT "telegram_links_source_valid" CHECK ("telegram_links"."source" IN ('legacy_migration', 'login_widget', 'web_app'))
);
--> statement-breakpoint
ALTER TABLE "telegram_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "legacy_id" text;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_legacy_id_key" ON "users" USING btree ("legacy_id") WHERE "users"."legacy_id" is not null;--> statement-breakpoint
CREATE POLICY "telegram_links_auth_only" ON "telegram_links" AS PERMISSIVE FOR ALL TO public USING (current_user = 'bahith_auth') WITH CHECK (current_user = 'bahith_auth');--> statement-breakpoint
-- Hand-written: identity data for the authentication connection only (see 0004).
GRANT SELECT, INSERT, DELETE ON telegram_links TO bahith_auth;--> statement-breakpoint
ALTER TABLE telegram_links FORCE ROW LEVEL SECURITY;
