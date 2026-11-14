CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_provider_account_key" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "auth_rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "auth_rate_limits_key_key" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "auth_rate_limits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "sessions_token_key" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "two_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" uuid NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "two_factors_user_id_key" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "two_factors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "two_factors_secret_idx" ON "two_factors" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE POLICY "users_self_select" ON "users" AS PERMISSIVE FOR SELECT TO public USING ("users"."id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "users_auth_manage" ON "users" AS PERMISSIVE FOR ALL TO public USING (current_user = 'bahith_auth') WITH CHECK (current_user = 'bahith_auth');--> statement-breakpoint
CREATE POLICY "accounts_auth_only" ON "accounts" AS PERMISSIVE FOR ALL TO public USING (current_user = 'bahith_auth') WITH CHECK (current_user = 'bahith_auth');--> statement-breakpoint
CREATE POLICY "auth_rate_limits_auth_only" ON "auth_rate_limits" AS PERMISSIVE FOR ALL TO public USING (current_user = 'bahith_auth') WITH CHECK (current_user = 'bahith_auth');--> statement-breakpoint
CREATE POLICY "sessions_auth_only" ON "sessions" AS PERMISSIVE FOR ALL TO public USING (current_user = 'bahith_auth') WITH CHECK (current_user = 'bahith_auth');--> statement-breakpoint
CREATE POLICY "two_factors_auth_only" ON "two_factors" AS PERMISSIVE FOR ALL TO public USING (current_user = 'bahith_auth') WITH CHECK (current_user = 'bahith_auth');--> statement-breakpoint
CREATE POLICY "verifications_auth_only" ON "verifications" AS PERMISSIVE FOR ALL TO public USING (current_user = 'bahith_auth') WITH CHECK (current_user = 'bahith_auth');
--> statement-breakpoint
-- Authentication never shares the application role or owns tables.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bahith_auth') THEN
    CREATE ROLE bahith_auth NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bahith_identity_provisioner') THEN
    CREATE ROLE bahith_identity_provisioner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  END IF;
END
$$;
ALTER ROLE bahith_auth NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
ALTER ROLE bahith_identity_provisioner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
GRANT USAGE ON SCHEMA public TO bahith_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, accounts, verifications, two_factors, auth_rate_limits TO bahith_auth;
REVOKE INSERT, UPDATE ON users FROM bahith_app;
REVOKE ALL ON sessions, accounts, verifications, two_factors, auth_rate_limits FROM PUBLIC, bahith_app;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE verifications FORCE ROW LEVEL SECURITY;
ALTER TABLE two_factors FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_rate_limits FORCE ROW LEVEL SECURITY;

--> statement-breakpoint
-- The trigger owner has no identity-table privileges and no RLS bypass. Its two
-- INSERT grants are restricted by the ordinary forced tenant policies.
GRANT USAGE ON SCHEMA public, app TO bahith_identity_provisioner;
GRANT INSERT ON workspaces, memberships TO bahith_identity_provisioner;
CREATE FUNCTION app.provision_personal_workspace() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  personal_workspace uuid := pg_catalog.gen_random_uuid();
  previous_workspace text := pg_catalog.current_setting('app.workspace_id', true);
  previous_user text := pg_catalog.current_setting('app.user_id', true);
BEGIN
  PERFORM pg_catalog.set_config('app.workspace_id', personal_workspace::text, true);
  PERFORM pg_catalog.set_config('app.user_id', NEW.id::text, true);
  INSERT INTO public.workspaces (id, name, kind, created_by)
    VALUES (personal_workspace, NEW.name, 'personal', NEW.id);
  INSERT INTO public.memberships (workspace_id, user_id, role)
    VALUES (personal_workspace, NEW.id, 'owner');
  PERFORM pg_catalog.set_config('app.workspace_id', coalesce(previous_workspace, ''), true);
  PERFORM pg_catalog.set_config('app.user_id', coalesce(previous_user, ''), true);
  RETURN NEW;
END;
$$;
GRANT CREATE ON SCHEMA app TO bahith_identity_provisioner;
ALTER FUNCTION app.provision_personal_workspace() OWNER TO bahith_identity_provisioner;
REVOKE CREATE ON SCHEMA app FROM bahith_identity_provisioner;
REVOKE ALL ON FUNCTION app.provision_personal_workspace() FROM PUBLIC;
CREATE TRIGGER users_personal_workspace AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION app.provision_personal_workspace();
