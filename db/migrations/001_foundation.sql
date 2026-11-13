BEGIN;
CREATE SCHEMA bahith;
CREATE ROLE bahith_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE TABLE bahith.users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject text UNIQUE NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bahith.workspaces (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bahith.memberships (
 workspace_id uuid NOT NULL REFERENCES bahith.workspaces(id), user_id uuid NOT NULL REFERENCES bahith.users(id),
 role text NOT NULL CHECK(role IN ('owner','editor','reviewer','viewer')), PRIMARY KEY(workspace_id,user_id)
);
-- Identity is set only by a trusted backend after session validation, transaction-local.
CREATE FUNCTION bahith.actor_id() RETURNS uuid LANGUAGE sql STABLE AS
 $$ SELECT nullif(current_setting('app.user_id',true),'')::uuid $$;
CREATE FUNCTION bahith.workspace_id() RETURNS uuid LANGUAGE sql STABLE AS
 $$ SELECT nullif(current_setting('app.workspace_id',true),'')::uuid $$;
ALTER TABLE bahith.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE bahith.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY self_membership ON bahith.memberships FOR SELECT TO bahith_app USING (user_id=bahith.actor_id());
ALTER TABLE bahith.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE bahith.workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY member_workspace ON bahith.workspaces FOR SELECT TO bahith_app USING (
 id=bahith.workspace_id() AND EXISTS (SELECT 1 FROM bahith.memberships m WHERE m.workspace_id=id AND m.user_id=bahith.actor_id())
);
CREATE TABLE bahith.projects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES bahith.workspaces(id),
 title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 300), research_question text,
 locale text NOT NULL DEFAULT 'ar' CHECK(locale IN ('ar','en')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,id)
);
CREATE TABLE bahith.sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
 project_id uuid NOT NULL, title text NOT NULL, doi text, csl jsonb NOT NULL DEFAULT '{}',
 metadata_status text NOT NULL DEFAULT 'unverified' CHECK(metadata_status IN ('unverified','verified','conflict')),
 access_status text NOT NULL DEFAULT 'metadata_only' CHECK(access_status IN ('fulltext','abstract','metadata_only','unavailable')),
 license_uri text, retrieved_at timestamptz, UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,project_id) REFERENCES bahith.projects(workspace_id,id)
);
CREATE TABLE bahith.source_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, source_id uuid NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), storage_key text NOT NULL,
 parser_version text NOT NULL, metadata_snapshot jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,source_id) REFERENCES bahith.sources(workspace_id,id)
);
CREATE TABLE bahith.chunks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, source_version_id uuid NOT NULL,
 body text NOT NULL, locator jsonb NOT NULL, search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple',body)) STORED,
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,source_version_id) REFERENCES bahith.source_versions(workspace_id,id)
);
CREATE INDEX chunks_lexical ON bahith.chunks USING gin(search_vector);
CREATE TABLE bahith.claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, project_id uuid NOT NULL,
 body text NOT NULL, kind text NOT NULL CHECK(kind IN ('fact','inference','hypothesis')),
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,project_id) REFERENCES bahith.projects(workspace_id,id)
);
CREATE TABLE bahith.evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, claim_id uuid NOT NULL, chunk_id uuid NOT NULL,
 quote text NOT NULL CHECK(length(trim(quote))>0), start_offset integer NOT NULL CHECK(start_offset>=0),
 end_offset integer NOT NULL CHECK(end_offset>start_offset), UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,claim_id) REFERENCES bahith.claims(workspace_id,id),
 FOREIGN KEY(workspace_id,chunk_id) REFERENCES bahith.chunks(workspace_id,id)
);
CREATE TABLE bahith.reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, evidence_id uuid NOT NULL,
 reviewer_id uuid NOT NULL, verdict text NOT NULL CHECK(verdict IN ('supported','partial','contradicted','unverifiable')),
 rationale text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,evidence_id) REFERENCES bahith.evidence(workspace_id,id),
 FOREIGN KEY(workspace_id,reviewer_id) REFERENCES bahith.memberships(workspace_id,user_id)
);
-- Reviews are append-only, human identity-bound, never writable by an AI provider.
ALTER TABLE bahith.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE bahith.reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY read_review ON bahith.reviews FOR SELECT TO bahith_app USING (
 workspace_id=bahith.workspace_id() AND EXISTS (SELECT 1 FROM bahith.memberships m WHERE m.workspace_id=reviews.workspace_id AND m.user_id=bahith.actor_id()));
CREATE POLICY create_review ON bahith.reviews FOR INSERT TO bahith_app WITH CHECK (
 workspace_id=bahith.workspace_id() AND reviewer_id=bahith.actor_id() AND EXISTS (SELECT 1 FROM bahith.memberships m WHERE m.workspace_id=reviews.workspace_id AND m.user_id=bahith.actor_id() AND m.role IN ('owner','editor','reviewer')));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['projects','sources','source_versions','chunks','claims','evidence'] LOOP
  EXECUTE format('ALTER TABLE bahith.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE bahith.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_read ON bahith.%I FOR SELECT TO bahith_app USING (workspace_id=bahith.workspace_id() AND EXISTS (SELECT 1 FROM bahith.memberships m WHERE m.workspace_id=%I.workspace_id AND m.user_id=bahith.actor_id()))',t,t);
  EXECUTE format('CREATE POLICY tenant_write ON bahith.%I FOR ALL TO bahith_app USING (workspace_id=bahith.workspace_id() AND EXISTS (SELECT 1 FROM bahith.memberships m WHERE m.workspace_id=%I.workspace_id AND m.user_id=bahith.actor_id() AND m.role IN (''owner'',''editor''))) WITH CHECK (workspace_id=bahith.workspace_id() AND EXISTS (SELECT 1 FROM bahith.memberships m WHERE m.workspace_id=%I.workspace_id AND m.user_id=bahith.actor_id() AND m.role IN (''owner'',''editor'')))',t,t,t);
  EXECUTE format('CREATE INDEX ON bahith.%I(workspace_id)',t);
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA bahith TO bahith_app;
GRANT SELECT ON bahith.workspaces,bahith.memberships TO bahith_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON bahith.projects,bahith.sources,bahith.source_versions,bahith.chunks,bahith.claims,bahith.evidence TO bahith_app;
GRANT SELECT,INSERT ON bahith.reviews TO bahith_app;
-- Immutable evidence graph; deletion requires the audited retention service.
REVOKE UPDATE,DELETE ON bahith.source_versions,bahith.chunks,bahith.claims,bahith.evidence FROM bahith_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA bahith FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bahith.actor_id(),bahith.workspace_id() TO bahith_app;
COMMIT;
