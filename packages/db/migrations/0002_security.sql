-- Security: the application role, its privileges, and forced row-level security.
--
-- The application connects as "bahith_app": no SUPERUSER, no BYPASSRLS, and it owns
-- nothing. The role is created without LOGIN; the deploy step (src/provision.ts) turns
-- LOGIN on with a password taken from the environment, so no secret lives in a migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bahith_app') THEN
    CREATE ROLE bahith_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;
--> statement-breakpoint
ALTER ROLE bahith_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
--> statement-breakpoint
-- Every privilege of the application role is listed explicitly below.
GRANT USAGE ON SCHEMA public TO bahith_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO bahith_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.normalize_arabic(text) TO bahith_app;
--> statement-breakpoint
-- Global tables (no workspace_id).
GRANT SELECT, INSERT, UPDATE ON users TO bahith_app;
--> statement-breakpoint
GRANT SELECT ON plans TO bahith_app;
--> statement-breakpoint
-- Deleting a workspace is a privileged operation: not available to the application role.
GRANT SELECT, INSERT, UPDATE ON workspaces TO bahith_app;
--> statement-breakpoint
-- Tenant tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON research_plans TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sources TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON project_sources TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON files TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON chunks TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON conversations TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON messages TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON claims TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON claim_evidence TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON citations TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON literature_matrix_rows TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_runs TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON exports TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON subscriptions TO bahith_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_counters TO bahith_app;
--> statement-breakpoint
-- Versions are immutable: no UPDATE.
GRANT SELECT, INSERT, DELETE ON document_versions TO bahith_app;
--> statement-breakpoint
-- The audit trail is append-only: no UPDATE, no DELETE.
GRANT SELECT, INSERT ON audit_log TO bahith_app;
--> statement-breakpoint
-- FORCE makes the policies apply to the table owner as well (superusers still bypass).
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE research_plans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sources FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE project_sources FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE chunks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE claims FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE claim_evidence FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE citations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE literature_matrix_rows FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE exports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
