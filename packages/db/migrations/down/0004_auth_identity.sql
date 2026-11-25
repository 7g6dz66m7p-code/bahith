-- Restore the preceding schema and its documented identity grants exactly.
DROP TRIGGER users_personal_workspace ON users;
DROP FUNCTION app.provision_personal_workspace();
REVOKE INSERT ON workspaces, memberships FROM bahith_identity_provisioner;
REVOKE USAGE ON SCHEMA public, app FROM bahith_identity_provisioner;
DROP ROLE bahith_identity_provisioner;
DROP TABLE auth_rate_limits, two_factors, sessions, accounts, verifications;
DROP POLICY users_self_select ON users;
DROP POLICY users_auth_manage ON users;
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON users FROM bahith_auth;
REVOKE USAGE ON SCHEMA public FROM bahith_auth;
DROP ROLE bahith_auth;
GRANT INSERT, UPDATE ON users TO bahith_app;
