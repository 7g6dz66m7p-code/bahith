import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadMigrations, migrateUp, rollbackLast } from '../../src/migrator';
import { POSTGRES_IMAGE } from '../../src/testing';

/**
 * Every migration must have a working down migration (engineering policy, section 10).
 * Runs in its own container because the last down migration drops the cluster-wide
 * application role.
 */

const names = z.array(z.object({ name: z.string() }));

async function listNames(client: pg.Client, query: string): Promise<string[]> {
  return names.parse((await client.query(query)).rows).map((row) => row.name);
}

const TABLES = `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`;
const ENUMS = `SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
               WHERE n.nspname = 'public' AND t.typtype = 'e' ORDER BY 1`;
const POLICIES = `SELECT policyname AS name FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`;
const EXTENSIONS = `SELECT extname AS name FROM pg_extension WHERE extname = 'vector'`;
const SCHEMAS = `SELECT nspname AS name FROM pg_namespace WHERE nspname = 'app'`;
const ROLES = `SELECT rolname AS name FROM pg_roles WHERE rolname IN ('bahith_app', 'bahith_auth', 'bahith_identity_provisioner') ORDER BY 1`;

describe('migrations', () => {
  let container: StartedPostgreSqlContainer;
  let client: pg.Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    client = new pg.Client({ connectionString: container.getConnectionUri() });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it('applies every migration on an empty database', async () => {
    const all = await loadMigrations();
    expect(await migrateUp(client)).toEqual(all.map((m) => m.tag));

    expect(await listNames(client, TABLES)).toHaveLength(37 + 1); // + schema_migrations
    expect(await listNames(client, EXTENSIONS)).toEqual(['vector']);
    expect(await listNames(client, ROLES)).toEqual([
      'bahith_app',
      'bahith_auth',
      'bahith_identity_provisioner',
    ]);
  });

  it('is idempotent: a second run applies nothing', async () => {
    expect(await migrateUp(client)).toEqual([]);
  });

  it('creates the HNSW and GIN indexes on chunks', async () => {
    const result = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'chunks' AND indexname IN ('chunks_embedding_hnsw', 'chunks_tsv_gin')
       ORDER BY indexname`,
    );
    const rows = z
      .array(z.object({ indexname: z.string(), indexdef: z.string() }))
      .parse(result.rows);
    expect(rows.map((row) => row.indexname)).toEqual(['chunks_embedding_hnsw', 'chunks_tsv_gin']);
    expect(rows[0]?.indexdef).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/);
    expect(rows[1]?.indexdef).toMatch(/USING gin \(tsv\)/);
  });

  it('refuses to run when an applied migration was edited afterwards', async () => {
    const all = await loadMigrations();
    const tampered = all.map((m, i) => (i === 0 ? { ...m, checksum: 'different' } : m));
    await expect(migrateUp(client, tampered)).rejects.toMatchObject({
      code: 'DB_MIGRATION_CHECKSUM_MISMATCH',
    });
  });

  it('refuses to run against a database that is ahead of the code', async () => {
    const all = await loadMigrations();
    await expect(migrateUp(client, all.slice(0, -1))).rejects.toMatchObject({
      code: 'DB_MIGRATION_UNKNOWN',
    });
  });

  /** Rolls back `tag` and every later migration, checking the order; returns their tags. */
  async function rollBackThrough(tag: string): Promise<string[]> {
    const tags = (await loadMigrations()).map((m) => m.tag);
    const later = tags.slice(tags.indexOf(tag));
    expect(later[0]).toBe(tag);
    expect(await rollbackLast(client, later.length)).toEqual([...later].reverse());
    return later;
  }

  async function reapply(tags: string[]): Promise<void> {
    expect(await migrateUp(client)).toEqual(tags);
  }

  it('rolls back the per-model token stats on their own', async () => {
    const keys = `SELECT jsonb_object_keys(app.platform_stats()) AS name ORDER BY 1`;
    expect(await listNames(client, keys)).toContain('aiTokensThisMonth');
    const tags = await rollBackThrough('0016_ai_usage_stats');
    expect(tags).toEqual(['0016_ai_usage_stats']);
    expect(await listNames(client, keys)).not.toContain('aiTokensThisMonth');
    expect(await listNames(client, keys)).toContain('aiRequestsThisMonth');
    await reapply(tags);
    expect(await listNames(client, keys)).toContain('aiTokensThisMonth');
  });

  it('rolls back Telegram links and users.legacy_id on their own', async () => {
    const table = `SELECT tablename AS name FROM pg_tables WHERE tablename = 'telegram_links'`;
    const legacy = `SELECT column_name AS name FROM information_schema.columns
                    WHERE table_name = 'users' AND column_name = 'legacy_id'`;
    const grants = `SELECT grantee || ':' || privilege_type AS name
                    FROM information_schema.role_table_grants
                    WHERE table_name = 'telegram_links'
                      AND grantee IN ('bahith_app', 'bahith_auth') ORDER BY 1`;
    // Only the authentication connection; links are replaced, never edited.
    const expectedGrants = ['bahith_auth:DELETE', 'bahith_auth:INSERT', 'bahith_auth:SELECT'];
    expect(await listNames(client, table)).toEqual(['telegram_links']);
    expect(await listNames(client, legacy)).toEqual(['legacy_id']);
    expect(await listNames(client, grants)).toEqual(expectedGrants);
    const tags = await rollBackThrough('0015_telegram_links');
    expect(tags[0]).toBe('0015_telegram_links');
    expect(await listNames(client, table)).toEqual([]);
    expect(await listNames(client, legacy)).toEqual([]);
    await reapply(tags);
    expect(await listNames(client, grants)).toEqual(expectedGrants);
  });

  it('rolls back payments on their own', async () => {
    const tables = `SELECT tablename AS name FROM pg_tables
                    WHERE tablename IN ('payments', 'payment_events') ORDER BY 1`;
    const forced = `SELECT relname || ':' || relforcerowsecurity::text AS name FROM pg_class
                    WHERE relname IN ('payments', 'payment_events') AND relkind = 'r' ORDER BY 1`;
    const grants = `SELECT table_name || ':' || privilege_type AS name
                    FROM information_schema.role_table_grants
                    WHERE table_name IN ('payments', 'payment_events')
                      AND grantee = 'bahith_app' ORDER BY 1`;
    const priceCols = `SELECT column_name AS name FROM information_schema.columns
                       WHERE table_name = 'plans'
                         AND column_name IN ('price_minor', 'currency', 'period_days') ORDER BY 1`;
    // No DELETE on financial records; events are append-only.
    const expectedGrants = [
      'payment_events:INSERT',
      'payment_events:SELECT',
      'payments:INSERT',
      'payments:SELECT',
      'payments:UPDATE',
    ];
    expect(await listNames(client, forced)).toEqual(['payment_events:true', 'payments:true']);
    expect(await listNames(client, grants)).toEqual(expectedGrants);
    expect(await listNames(client, priceCols)).toEqual(['currency', 'period_days', 'price_minor']);
    const tags = await rollBackThrough('0014_payments');
    expect(tags[0]).toBe('0014_payments');
    expect(await listNames(client, tables)).toEqual([]);
    expect(await listNames(client, priceCols)).toEqual([]);
    expect(await listNames(client, TABLES)).toHaveLength(34 + 1);
    await reapply(tags);
    expect(await listNames(client, grants)).toEqual(expectedGrants);
  });

  it('rolls back the phone number columns on their own', async () => {
    const cols = `SELECT column_name AS name FROM information_schema.columns
                  WHERE table_name = 'users' AND column_name LIKE 'phone_number%' ORDER BY 1`;
    expect(await listNames(client, cols)).toEqual(['phone_number', 'phone_number_verified']);
    const tags = await rollBackThrough('0011_phone_number');
    expect(tags[0]).toBe('0011_phone_number');
    expect(await listNames(client, cols)).toEqual([]);
    await reapply(tags);
  });

  it('rolls back the platform admin functions on their own', async () => {
    const fns = `SELECT proname AS name FROM pg_proc WHERE pronamespace = 'app'::regnamespace
                 AND proname IN ('platform_stats', 'set_plan_limit') ORDER BY 1`;
    expect(await listNames(client, fns)).toEqual(['platform_stats', 'set_plan_limit']);
    const tags = await rollBackThrough('0010_platform_admin');
    expect(tags[0]).toBe('0010_platform_admin');
    expect(await listNames(client, fns)).toEqual([]);
    await reapply(tags);
    expect(await listNames(client, fns)).toEqual(['platform_stats', 'set_plan_limit']);
  });

  it('rolls back notifications and their enum on their own', async () => {
    const table = `SELECT tablename AS name FROM pg_tables WHERE tablename = 'notifications'`;
    const enums = `SELECT typname AS name FROM pg_type WHERE typname = 'notification_kind'`;
    const policy = `SELECT policyname AS name FROM pg_policies WHERE tablename = 'notifications'`;
    const forced = `SELECT relforcerowsecurity::text AS name FROM pg_class
                    WHERE oid = 'notifications'::regclass`;
    const grants = `SELECT privilege_type AS name FROM information_schema.role_table_grants
                    WHERE table_name = 'notifications' AND grantee = 'bahith_app' ORDER BY 1`;
    expect(await listNames(client, table)).toEqual(['notifications']);
    expect(await listNames(client, enums)).toEqual(['notification_kind']);
    expect(await listNames(client, policy)).toEqual(['notifications_tenant_isolation']);
    expect(await listNames(client, forced)).toEqual(['true']);
    expect(await listNames(client, grants)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    const tags = await rollBackThrough('0012_notifications');
    expect(tags[0]).toBe('0012_notifications');
    expect(await listNames(client, table)).toEqual([]);
    expect(await listNames(client, enums)).toEqual([]);
    expect(await listNames(client, TABLES)).toHaveLength(30 + 1);
    await reapply(tags);
    expect(await listNames(client, policy)).toEqual(['notifications_tenant_isolation']);
    expect(await listNames(client, grants)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });

  it('rolls back library organisation (collections, highlights) on its own', async () => {
    const tables = `SELECT tablename AS name FROM pg_tables
                    WHERE tablename IN ('collections', 'collection_sources', 'highlights') ORDER BY 1`;
    const forced = `SELECT relname || ':' || relforcerowsecurity::text AS name FROM pg_class
                    WHERE relname IN ('collections', 'collection_sources', 'highlights')
                      AND relkind = 'r' ORDER BY 1`;
    const grants = `SELECT table_name || ':' || privilege_type AS name
                    FROM information_schema.role_table_grants
                    WHERE table_name IN ('collections', 'collection_sources', 'highlights')
                      AND grantee = 'bahith_app' ORDER BY 1`;
    const colorEnum = `SELECT typname AS name FROM pg_type WHERE typname = 'highlight_color'`;
    const expectedGrants = [
      'collection_sources:DELETE',
      'collection_sources:INSERT',
      'collection_sources:SELECT',
      'collections:DELETE',
      'collections:INSERT',
      'collections:SELECT',
      'collections:UPDATE',
      'highlights:DELETE',
      'highlights:INSERT',
      'highlights:SELECT',
      'highlights:UPDATE',
    ];
    expect(await listNames(client, tables)).toEqual([
      'collection_sources',
      'collections',
      'highlights',
    ]);
    expect(await listNames(client, forced)).toEqual([
      'collection_sources:true',
      'collections:true',
      'highlights:true',
    ]);
    expect(await listNames(client, grants)).toEqual(expectedGrants);
    expect(await listNames(client, colorEnum)).toEqual(['highlight_color']);
    const tags = await rollBackThrough('0013_library_organisation');
    expect(tags[0]).toBe('0013_library_organisation');
    expect(await listNames(client, tables)).toEqual([]);
    expect(await listNames(client, colorEnum)).toEqual([]);
    expect(await listNames(client, TABLES)).toHaveLength(31 + 1);
    await reapply(tags);
    expect(await listNames(client, grants)).toEqual(expectedGrants);
  });

  it('rolls back workspace invitations on their own', async () => {
    const table = `SELECT tablename AS name FROM pg_tables WHERE tablename = 'workspace_invitations'`;
    const forced = `SELECT relforcerowsecurity::text AS name FROM pg_class
                    WHERE oid = 'workspace_invitations'::regclass`;
    const grants = `SELECT privilege_type AS name FROM information_schema.role_table_grants
                    WHERE table_name = 'workspace_invitations' AND grantee = 'bahith_app' ORDER BY 1`;
    expect(await listNames(client, table)).toEqual(['workspace_invitations']);
    expect(await listNames(client, forced)).toEqual(['true']);
    expect(await listNames(client, grants)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    const tags = await rollBackThrough('0009_workspace_invitations');
    expect(tags[0]).toBe('0009_workspace_invitations');
    expect(await listNames(client, table)).toEqual([]);
    await reapply(tags);
    expect(await listNames(client, grants)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });

  it('rolls back the draft review table and its enums on their own', async () => {
    const table = `SELECT tablename AS name FROM pg_tables WHERE tablename = 'document_comments'`;
    const enums = `SELECT typname AS name FROM pg_type
                   WHERE typname IN ('document_comment_kind', 'document_comment_status') ORDER BY 1`;
    const policy = `SELECT policyname AS name FROM pg_policies WHERE tablename = 'document_comments'`;
    const forced = `SELECT relforcerowsecurity::text AS name FROM pg_class
                    WHERE oid = 'document_comments'::regclass`;
    const grants = `SELECT privilege_type AS name FROM information_schema.role_table_grants
                    WHERE table_name = 'document_comments' AND grantee = 'bahith_app' ORDER BY 1`;
    expect(await listNames(client, table)).toEqual(['document_comments']);
    expect(await listNames(client, enums)).toEqual([
      'document_comment_kind',
      'document_comment_status',
    ]);
    expect(await listNames(client, policy)).toEqual(['document_comments_tenant_isolation']);
    expect(await listNames(client, forced)).toEqual(['true']);
    expect(await listNames(client, grants)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    const tags = await rollBackThrough('0008_document_review');
    expect(tags[0]).toBe('0008_document_review');
    expect(await listNames(client, table)).toEqual([]);
    expect(await listNames(client, enums)).toEqual([]);
    expect(await listNames(client, TABLES)).toHaveLength(28 + 1);
    await reapply(tags);
    expect(await listNames(client, policy)).toEqual(['document_comments_tenant_isolation']);
    expect(await listNames(client, grants)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });

  it('rolls back the project AI consent columns on their own', async () => {
    const consent = `SELECT column_name AS name FROM information_schema.columns
                     WHERE table_name = 'projects' AND column_name LIKE 'ai_consent%' ORDER BY 1`;
    expect(await listNames(client, consent)).toEqual(['ai_consent_at', 'ai_consent_by']);
    const tags = await rollBackThrough('0007_project_ai_consent');
    expect(await listNames(client, consent)).toEqual([]);
    await reapply(tags);
  });

  it('rolls back stemmed lexical search to surface forms, then restores it', async () => {
    const functions = `SELECT proname AS name FROM pg_proc
                       WHERE pronamespace = 'app'::regnamespace AND proname LIKE '%stem%'
                          OR proname IN ('search_document', 'search_term_queries')`;
    const stemmed = `SELECT app.search_document('بتدريب المعلمين') @@
                            (app.search_term_queries('تدريب'))[1] AS name`;
    expect(await listNames(client, functions)).toEqual([
      'arabic_light_stem',
      'search_document',
      'search_term_queries',
    ]);
    expect((await client.query(stemmed)).rows).toEqual([{ name: true }]);
    const tags = await rollBackThrough('0006_search_stemming');
    expect(await listNames(client, functions)).toEqual([]);
    const index = `SELECT indexname AS name FROM pg_indexes WHERE indexname = 'chunks_tsv_gin'`;
    expect(await listNames(client, index)).toEqual(['chunks_tsv_gin']);
    await reapply(tags);
    expect(await listNames(client, index)).toEqual(['chunks_tsv_gin']);
  });

  it('rolls back the library duplicate-detection index on its own', async () => {
    const indexQuery = `SELECT indexname AS name FROM pg_indexes
                        WHERE indexname = 'files_workspace_id_sha256_key'`;
    expect(await listNames(client, indexQuery)).toEqual(['files_workspace_id_sha256_key']);
    const tags = await rollBackThrough('0005_library_dedup');
    expect(await listNames(client, indexQuery)).toEqual([]);
    await reapply(tags);
  });

  it('rolls back private identity tables and roles before the preceding schema', async () => {
    const tags = await rollBackThrough(['0004', 'auth', 'identity'].join('_'));
    expect(await listNames(client, ROLES)).toEqual(['bahith_app']);
    expect(await listNames(client, TABLES)).toHaveLength(23 + 1);
    expect(
      (await client.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'users'::regclass`))
        .rows,
    ).toEqual([{ relrowsecurity: false }]);
    await reapply(tags);
  });

  it('can still roll back provenance while retaining the existing research schema', async () => {
    const tags = await rollBackThrough('0003_sanad_provenance');
    expect(await listNames(client, ROLES)).toEqual(['bahith_app']);
    const columns = await listNames(
      client,
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_name IN ('files', 'chunks') AND column_name IN ('extraction', 'provenance')`,
    );
    expect(columns).toEqual([]);
    await reapply(tags);
  });

  it('can still roll back the preceding security migration', async () => {
    const tags = await rollBackThrough('0002_security');
    expect(await listNames(client, ROLES)).toEqual([]);
    expect(await listNames(client, TABLES)).toHaveLength(23 + 1);
    await reapply(tags);
  });

  it('rolls everything back to an empty database, then applies it all again', async () => {
    const all = await loadMigrations();
    const reverted = await rollbackLast(client, all.length);
    expect(reverted).toEqual(all.map((m) => m.tag).reverse());

    expect(await listNames(client, TABLES)).toEqual(['schema_migrations']);
    expect(await listNames(client, ENUMS)).toEqual([]);
    expect(await listNames(client, POLICIES)).toEqual([]);
    expect(await listNames(client, EXTENSIONS)).toEqual([]);
    expect(await listNames(client, SCHEMAS)).toEqual([]);
    expect(await listNames(client, ROLES)).toEqual([]);
    expect(await rollbackLast(client)).toEqual([]);

    expect(await migrateUp(client)).toEqual(all.map((m) => m.tag));
    expect(await listNames(client, TABLES)).toHaveLength(37 + 1);
  });
});
