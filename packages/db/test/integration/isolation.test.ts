import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/client';
import { createDatabase } from '../../src/client';
import * as schema from '../../src/schema/index';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { seedWorkspace, tenantTableNames } from './fixtures';

/**
 * Phase 1 acceptance test: two users, data for each in every tenant table, and proof
 * that A can neither read nor write any row of B through any table — enforced by
 * Postgres row-level security, independently of application-level checks.
 */

const PG_INSUFFICIENT_PRIVILEGE = '42501'; // RLS violation or missing table privilege
const PG_FOREIGN_KEY_VIOLATION = '23503';

const countRow = z.object({ n: z.coerce.number() });

/** The SQLSTATE code of a Postgres error (Drizzle wraps the driver error as `cause`). */
function sqlStateOf(error: unknown): string {
  for (const candidate of [error, error instanceof Error ? error.cause : undefined]) {
    const parsed = z.object({ code: z.string() }).safeParse(candidate);
    if (parsed.success) {
      return parsed.data.code;
    }
  }
  throw error;
}

/** Runs `fn` and returns the Postgres error code it failed with (or fails the test). */
async function pgErrorCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return sqlStateOf(error);
  }
  throw new Error('expected the statement to fail, but it succeeded');
}

describe('workspace isolation (row-level security)', () => {
  let database: Database;
  let admin: pg.Client;
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;

  /** Row count as the superuser (bypasses RLS): the ground truth. */
  async function adminCount(table: string, workspaceId: string): Promise<number> {
    const result = await admin.query(
      `SELECT count(*) AS n FROM "${table}" WHERE workspace_id = $1`,
      [workspaceId],
    );
    return countRow.parse(result.rows[0]).n;
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    const plan = z
      .object({ id: z.string() })
      .parse((await admin.query(`SELECT id FROM plans WHERE code = 'free'`)).rows[0]);

    database = createDatabase({ connectionString: inject('appUrl') });
    a = await seedWorkspace(database, 'A', plan.id);
    b = await seedWorkspace(database, 'B', plan.id);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  describe('setup guarantees', () => {
    it('the application connects as a role without SUPERUSER or BYPASSRLS', async () => {
      const result = await database.pool.query(
        `SELECT current_user AS name, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
         FROM pg_roles WHERE rolname = current_user`,
      );
      expect(result.rows).toEqual([
        {
          name: schema.APP_ROLE,
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
        },
      ]);
    });

    it('the application role owns no table (owners could disable RLS)', async () => {
      const result = await admin.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = $1`,
        [schema.APP_ROLE],
      );
      expect(result.rows).toEqual([]);
    });

    it('every table with a workspace_id column has RLS enabled, forced, and a policy', async () => {
      const result = await admin.query(`
        SELECT c.relname AS table,
               c.relrowsecurity AS enabled,
               c.relforcerowsecurity AS forced,
               (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_attribute att
                      WHERE att.attrelid = c.oid AND att.attname = 'workspace_id'
                        AND NOT att.attisdropped)
        ORDER BY c.relname`);
      const rows = z
        .array(
          z.object({
            table: z.string(),
            enabled: z.boolean(),
            forced: z.boolean(),
            policies: z.number(),
          }),
        )
        .parse(result.rows);

      // The database and the Drizzle schema agree on which tables are tenant tables…
      expect(rows.map((row) => row.table)).toEqual(tenantTableNames);
      // …and the list is the one Phase 1 specifies (memberships + 19 research tables).
      expect(tenantTableNames).toHaveLength(20);
      for (const row of rows) {
        expect(row, row.table).toMatchObject({ enabled: true, forced: true });
        expect(row.policies, row.table).toBeGreaterThan(0);
      }
    });

    it('the workspaces table itself is protected by forced RLS', async () => {
      const result = await admin.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE oid = 'public.workspaces'::regclass`,
      );
      expect(result.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    });

    it('the fixture put data for both workspaces in every tenant table', async () => {
      for (const table of tenantTableNames) {
        expect(await adminCount(table, a.workspaceId), `${table} / A`).toBeGreaterThan(0);
        expect(await adminCount(table, b.workspaceId), `${table} / B`).toBeGreaterThan(0);
      }
    });
  });

  describe.each(tenantTableNames)('table %s', (table) => {
    it('A reads all of its own rows and none of B', async () => {
      const expected = await adminCount(table, a.workspaceId);
      const seen = await database.withWorkspace(a.workspaceId, async (tx) => {
        const total = await tx.execute(sql`SELECT count(*) AS n FROM ${sql.identifier(table)}`);
        const foreign = await tx.execute(
          sql`SELECT count(*) AS n FROM ${sql.identifier(table)}
              WHERE workspace_id = ${b.workspaceId}`,
        );
        return {
          total: countRow.parse(total.rows[0]).n,
          foreign: countRow.parse(foreign.rows[0]).n,
        };
      });
      expect(seen).toEqual({ total: expected, foreign: 0 });
    });

    it('B reads all of its own rows and none of A', async () => {
      const expected = await adminCount(table, b.workspaceId);
      const seen = await database.withWorkspace(b.workspaceId, async (tx) => {
        const total = await tx.execute(sql`SELECT count(*) AS n FROM ${sql.identifier(table)}`);
        const foreign = await tx.execute(
          sql`SELECT count(*) AS n FROM ${sql.identifier(table)}
              WHERE workspace_id = ${a.workspaceId}`,
        );
        return {
          total: countRow.parse(total.rows[0]).n,
          foreign: countRow.parse(foreign.rows[0]).n,
        };
      });
      expect(seen).toEqual({ total: expected, foreign: 0 });
    });

    it('returns no rows when no workspace is bound', async () => {
      const result = await database.db.execute(
        sql`SELECT count(*) AS n FROM ${sql.identifier(table)}`,
      );
      expect(countRow.parse(result.rows[0]).n).toBe(0);
    });

    it("A cannot update or delete B's rows", async () => {
      const before = await adminCount(table, b.workspaceId);

      for (const statement of [
        sql`UPDATE ${sql.identifier(table)} SET workspace_id = workspace_id
            WHERE workspace_id = ${b.workspaceId}`,
        sql`DELETE FROM ${sql.identifier(table)} WHERE workspace_id = ${b.workspaceId}`,
      ]) {
        // Either the statement touches zero rows (RLS hides them), or the application
        // role has no such privilege on this table at all (append-only tables).
        let outcome: number | string | null;
        try {
          outcome = await database.withWorkspace(
            a.workspaceId,
            async (tx) => (await tx.execute(statement)).rowCount,
          );
        } catch (error) {
          outcome = sqlStateOf(error);
        }
        expect([0, PG_INSUFFICIENT_PRIVILEGE]).toContain(outcome);
      }

      expect(await adminCount(table, b.workspaceId)).toBe(before);
    });

    it("A cannot move its own rows into B's workspace", async () => {
      const code = await pgErrorCode(() =>
        database.withWorkspace(a.workspaceId, (tx) =>
          tx.execute(
            sql`UPDATE ${sql.identifier(table)} SET workspace_id = ${b.workspaceId}
                WHERE workspace_id = ${a.workspaceId}`,
          ),
        ),
      );
      expect(code).toBe(PG_INSUFFICIENT_PRIVILEGE);
      expect(await adminCount(table, a.workspaceId)).toBeGreaterThan(0);
    });
  });

  describe('writes across workspaces', () => {
    it("A cannot insert rows into B's workspace", async () => {
      const attempts: (() => Promise<unknown>)[] = [
        () =>
          database.withWorkspace(a.workspaceId, (tx) =>
            tx.insert(schema.projects).values({ workspaceId: b.workspaceId, title: 'intruder' }),
          ),
        () =>
          database.withWorkspace(a.workspaceId, (tx) =>
            tx.insert(schema.sources).values({
              workspaceId: b.workspaceId,
              origin: 'manual',
              type: 'book',
              title: 'intruder',
            }),
          ),
        () =>
          database.withWorkspace(a.workspaceId, (tx) =>
            tx.insert(schema.chunks).values({
              workspaceId: b.workspaceId,
              sourceId: b.sourceId,
              chunkIndex: 99,
              content: 'intruder',
            }),
          ),
        () =>
          database.withWorkspace(a.workspaceId, (tx) =>
            tx
              .insert(schema.auditLog)
              .values({ workspaceId: b.workspaceId, action: 'intruder.action' }),
          ),
        () =>
          database.withWorkspace(a.workspaceId, (tx) =>
            tx.insert(schema.documentVersions).values({
              workspaceId: b.workspaceId,
              documentId: b.documentId,
              version: 99,
              content: {},
            }),
          ),
        () =>
          database.withWorkspace(a.workspaceId, (tx) =>
            tx
              .insert(schema.memberships)
              .values({ workspaceId: b.workspaceId, userId: a.userId, role: 'owner' }),
          ),
      ];
      for (const attempt of attempts) {
        expect(await pgErrorCode(attempt)).toBe(PG_INSUFFICIENT_PRIVILEGE);
      }
    });

    it("A cannot attach its own rows to B's parents (composite foreign keys)", async () => {
      // Foreign-key checks bypass RLS, so a guessed id from another workspace must be
      // stopped by the (workspace_id, id) composite keys instead.
      const attempts: (() => Promise<unknown>)[] = [
        () =>
          database.withWorkspace(a.workspaceId, (tx) =>
            tx.insert(schema.researchPlans).values({
              workspaceId: a.workspaceId,
              projectId: b.projectId,
              version: 50,
              content: {},
            }),
          ),
        () =>
          database.withWorkspace(a.workspaceId, (tx) =>
            tx
              .insert(schema.claimEvidence)
              .values({ workspaceId: a.workspaceId, claimId: a.claimId, chunkId: b.chunkId }),
          ),
        () =>
          database.withWorkspace(a.workspaceId, (tx) =>
            tx.insert(schema.citations).values({
              workspaceId: a.workspaceId,
              documentId: a.documentId,
              sourceId: b.sourceId,
            }),
          ),
        () =>
          database.withWorkspace(a.workspaceId, (tx) =>
            tx
              .insert(schema.projectSources)
              .values({ workspaceId: a.workspaceId, projectId: a.projectId, sourceId: b.sourceId }),
          ),
      ];
      for (const attempt of attempts) {
        expect(await pgErrorCode(attempt)).toBe(PG_FOREIGN_KEY_VIOLATION);
      }
    });
  });

  describe('workspaces and memberships', () => {
    it('inside its workspace, A sees its own workspace row and membership only', async () => {
      const seen = await database.withWorkspace(a.workspaceId, async (tx) => ({
        workspaces: await tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
        memberships: await tx
          .select({ workspaceId: schema.memberships.workspaceId })
          .from(schema.memberships),
      }));
      expect(seen.workspaces).toEqual([{ id: a.workspaceId }]);
      expect(seen.memberships).toEqual([{ workspaceId: a.workspaceId }]);
    });

    it('bound to a user only, A can list its own workspaces but no tenant data', async () => {
      const seen = await database.withUser(a.userId, async (tx) => ({
        workspaces: await tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
        memberships: await tx
          .select({ userId: schema.memberships.userId })
          .from(schema.memberships),
        projects: await tx.select({ id: schema.projects.id }).from(schema.projects),
      }));
      expect(seen.workspaces).toEqual([{ id: a.workspaceId }]);
      expect(seen.memberships).toEqual([{ userId: a.userId }]);
      expect(seen.projects).toEqual([]);
    });

    it("A cannot rename B's workspace", async () => {
      const updated = await database.withWorkspace(a.workspaceId, (tx) =>
        tx
          .update(schema.workspaces)
          .set({ name: 'hijacked' })
          .where(eq(schema.workspaces.id, b.workspaceId))
          .returning({ id: schema.workspaces.id }),
      );
      expect(updated).toEqual([]);
      const result = await admin.query(`SELECT name FROM workspaces WHERE id = $1`, [
        b.workspaceId,
      ]);
      expect(result.rows).toEqual([{ name: 'Workspace B' }]);
    });

    it('the application role cannot delete a workspace', async () => {
      const code = await pgErrorCode(() =>
        database.withWorkspace(a.workspaceId, (tx) =>
          tx.delete(schema.workspaces).where(eq(schema.workspaces.id, a.workspaceId)),
        ),
      );
      expect(code).toBe(PG_INSUFFICIENT_PRIVILEGE);
    });
  });

  describe('privileges of the application role', () => {
    it('cannot change the plan catalogue', async () => {
      const code = await pgErrorCode(() =>
        database.db.update(schema.plans).set({ limits: { chat_messages: 1_000_000 } }),
      );
      expect(code).toBe(PG_INSUFFICIENT_PRIVILEGE);
    });

    it('cannot rewrite or erase the audit trail, even in its own workspace', async () => {
      for (const attempt of [
        () =>
          database.withWorkspace(a.workspaceId, (tx) =>
            tx.update(schema.auditLog).set({ action: 'rewritten' }),
          ),
        () => database.withWorkspace(a.workspaceId, (tx) => tx.delete(schema.auditLog)),
      ]) {
        expect(await pgErrorCode(attempt)).toBe(PG_INSUFFICIENT_PRIVILEGE);
      }
    });

    it('cannot alter a stored document version', async () => {
      const code = await pgErrorCode(() =>
        database.withWorkspace(a.workspaceId, (tx) =>
          tx.update(schema.documentVersions).set({ content: { tampered: true } }),
        ),
      );
      expect(code).toBe(PG_INSUFFICIENT_PRIVILEGE);
    });

    it('cannot disable row-level security', async () => {
      const code = await pgErrorCode(() =>
        database.pool.query('ALTER TABLE projects DISABLE ROW LEVEL SECURITY'),
      );
      expect(code).toBe(PG_INSUFFICIENT_PRIVILEGE);
    });
  });

  describe('withWorkspace', () => {
    it('does not leak the workspace to the next user of a pooled connection', async () => {
      const single = createDatabase({ connectionString: inject('appUrl'), max: 1 });
      try {
        const inside = await single.withWorkspace(a.workspaceId, (tx) =>
          tx.select({ id: schema.projects.id }).from(schema.projects),
        );
        expect(inside).toEqual([{ id: a.projectId }]);

        // Same physical connection (pool of one), no workspace bound any more.
        const after = await single.db.select({ id: schema.projects.id }).from(schema.projects);
        expect(after).toEqual([]);

        const other = await single.withWorkspace(b.workspaceId, (tx) =>
          tx.select({ id: schema.projects.id }).from(schema.projects),
        );
        expect(other).toEqual([{ id: b.projectId }]);
      } finally {
        await single.close();
      }
    });

    it('rolls the transaction back when the callback throws', async () => {
      const title = `rollback-${crypto.randomUUID()}`;
      await expect(
        database.withWorkspace(a.workspaceId, async (tx) => {
          await tx.insert(schema.projects).values({ workspaceId: a.workspaceId, title });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const result = await admin.query(`SELECT count(*) AS n FROM projects WHERE title = $1`, [
        title,
      ]);
      expect(countRow.parse(result.rows[0]).n).toBe(0);
    });

    it('rejects ids that are not UUIDs before touching the database', async () => {
      await expect(
        database.withWorkspace(`${a.workspaceId}'; DROP TABLE projects; --`, () =>
          Promise.resolve('unreachable'),
        ),
      ).rejects.toMatchObject({ code: 'DB_INVALID_CONTEXT' });
      await expect(
        database.withUser('not-a-uuid', () => Promise.resolve('unreachable')),
      ).rejects.toMatchObject({ code: 'DB_INVALID_CONTEXT' });
    });
  });
});
