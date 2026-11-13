import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/schema/index';
import { allTables } from '../tables';

/**
 * Static guards over the Drizzle schema. They fail the build when a future table
 * forgets the isolation rules, before any database is involved.
 */

const tables = allTables.map((table) => getTableConfig(table));

/** Tables that are global by design: they hold no research data. */
const GLOBAL_TABLES = new Set(['users', 'plans']);
/** The tenant root: isolated by its own id rather than by a workspace_id column. */
const TENANT_ROOT = 'workspaces';

const tenantTables = tables.filter(
  (table) => !GLOBAL_TABLES.has(table.name) && table.name !== TENANT_ROOT,
);

describe('database schema', () => {
  it('declares exactly the tables Phase 1 specifies', () => {
    expect(tables.map((table) => table.name).sort()).toEqual(
      [
        'agent_runs',
        'audit_log',
        'chunks',
        'citations',
        'claim_evidence',
        'claims',
        'conversations',
        'document_versions',
        'documents',
        'exports',
        'files',
        'literature_matrix_rows',
        'memberships',
        'messages',
        'plans',
        'project_sources',
        'projects',
        'research_plans',
        'sources',
        'subscriptions',
        'usage_counters',
        'users',
        'workspaces',
      ].sort(),
    );
  });

  it.each(tenantTables.map((table) => [table.name, table] as const))(
    '%s carries a NOT NULL workspace_id that references workspaces',
    (_name, table) => {
      const column = table.columns.find((c) => c.name === 'workspace_id');
      expect(column?.notNull).toBe(true);
      expect(column?.getSQLType()).toBe('uuid');

      const toWorkspaces = table.foreignKeys.some((fk) => {
        const ref = fk.reference();
        return (
          getTableConfig(ref.foreignTable).name === TENANT_ROOT &&
          ref.columns.map((c) => c.name).join() === 'workspace_id'
        );
      });
      expect(toWorkspaces).toBe(true);
    },
  );

  it.each(
    [...tenantTables, ...tables.filter((t) => t.name === TENANT_ROOT)].map(
      (t) => [t.name, t] as const,
    ),
  )('%s is protected by row-level-security policies', (_name, table) => {
    expect(table.policies.length).toBeGreaterThan(0);
    for (const policy of table.policies) {
      // Policies apply to every role; none is scoped away from the application role.
      expect(policy.to).toBe('public');
    }
  });

  it('global tables carry no workspace_id', () => {
    for (const table of tables.filter((t) => GLOBAL_TABLES.has(t.name))) {
      expect(table.columns.map((c) => c.name)).not.toContain('workspace_id');
    }
  });

  it('foreign keys between tenant tables always include workspace_id', () => {
    // FK checks bypass RLS: a single-column FK would let a row reference a parent in
    // another workspace. Composite (workspace_id, id) keys make that impossible.
    const tenantNames = new Set(tenantTables.map((table) => table.name));
    const offenders: string[] = [];
    for (const table of tenantTables) {
      for (const fk of table.foreignKeys) {
        const ref = fk.reference();
        const target = getTableConfig(ref.foreignTable).name;
        if (!tenantNames.has(target)) {
          continue; // references to users / workspaces / plans are global by design
        }
        const local = ref.columns.map((c) => c.name);
        const foreign = ref.foreignColumns.map((c) => c.name);
        if (local[0] !== 'workspace_id' || foreign[0] !== 'workspace_id' || local.length < 2) {
          offenders.push(`${table.name} -> ${target} (${local.join(', ')})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('constraint and index names fit the Postgres identifier limit', () => {
    const names = tables.flatMap((table) => [
      ...table.indexes.map((index) => index.config.name ?? ''),
      ...table.foreignKeys.map((fk) => fk.getName()),
      ...table.uniqueConstraints.map((unique) => unique.getName() ?? ''),
      ...table.checks.map((check) => check.name),
      ...table.policies.map((policy) => policy.name),
    ]);
    expect(names.filter((name) => name.length > 63)).toEqual([]);
  });

  it('fixes the embedding dimension in one place', () => {
    const chunks = tables.find((table) => table.name === 'chunks');
    const embedding = chunks?.columns.find((c) => c.name === 'embedding');
    expect(embedding?.getSQLType()).toBe(`vector(${schema.EMBEDDING_DIMENSIONS})`);
  });
});
