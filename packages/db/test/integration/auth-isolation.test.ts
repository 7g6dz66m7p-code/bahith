import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/client';
import { createDatabase } from '../../src/client';
import * as schema from '../../src/schema/index';

const INSUFFICIENT_PRIVILEGE = '42501';
const countRow = z.object({ n: z.coerce.number() });

async function errorCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    for (const candidate of [error, error instanceof Error ? error.cause : undefined]) {
      const parsed = z.object({ code: z.string() }).safeParse(candidate);
      if (parsed.success) return parsed.data.code;
    }
    throw error;
  }
  throw new Error('Expected the database operation to fail.');
}

function only<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined || rows.length !== 1) throw new Error('Expected one fixture row.');
  return row;
}

describe('private identity role and atomic personal workspace provisioning', () => {
  let app: Database;
  let auth: Database;
  let admin: pg.Client;
  let a: { id: string; email: string; name: string };
  let b: { id: string; email: string; name: string };
  let workspaceId: string;
  let verificationId: string;
  let rateLimitId: string;

  beforeAll(async () => {
    // A pool of one proves restoration on the same physical connection.
    app = createDatabase({ connectionString: inject('appUrl'), max: 1 });
    auth = createDatabase({ connectionString: inject('authUrl'), max: 1 });
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    const suffix = crypto.randomUUID();
    [a, b] = await Promise.all([
      auth.db
        .insert(schema.users)
        .values({ name: `Identity A ${suffix}`, email: `identity-a-${suffix}@example.test` })
        .returning({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
        .then(only),
      auth.db
        .insert(schema.users)
        .values({ name: `Identity B ${suffix}`, email: `identity-b-${suffix}@example.test` })
        .returning({ id: schema.users.id, email: schema.users.email, name: schema.users.name })
        .then(only),
    ]);
    workspaceId = only(
      await app.withUser(a.id, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      ),
    ).id;
    const expiresAt = new Date(Date.now() + 3_600_000);
    await auth.db
      .insert(schema.sessions)
      .values({ userId: a.id, token: `synthetic-session-fixture-${suffix}`, expiresAt });
    await auth.db.insert(schema.accounts).values({
      userId: a.id,
      accountId: a.id,
      providerId: 'credential',
      password: 'synthetic-credential-digest-fixture',
    });
    verificationId = only(
      await auth.db
        .insert(schema.verifications)
        .values({
          identifier: `synthetic-verification-${suffix}`,
          value: 'synthetic-one-time-token-fixture',
          expiresAt,
        })
        .returning({ id: schema.verifications.id }),
    ).id;
    await auth.db.insert(schema.twoFactors).values({
      userId: a.id,
      secret: 'synthetic-totp-secret-fixture',
      backupCodes: 'synthetic-backup-codes-fixture',
    });
    rateLimitId = only(
      await auth.db
        .insert(schema.authRateLimits)
        .values({ key: `synthetic-rate-limit-${suffix}`, count: 1, lastRequest: Date.now() })
        .returning({ id: schema.authRateLimits.id }),
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await auth.close();
    await admin.end();
  });

  it('uses distinct unprivileged login roles that own no tables', async () => {
    const result = await admin.query(
      `SELECT rolname AS name, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin
       FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
      [[schema.APP_ROLE, schema.AUTH_ROLE, schema.IDENTITY_PROVISIONER_ROLE]],
    );
    expect(result.rows).toEqual([
      {
        name: schema.APP_ROLE,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolcanlogin: true,
      },
      {
        name: schema.AUTH_ROLE,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolcanlogin: true,
      },
      {
        name: schema.IDENTITY_PROVISIONER_ROLE,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolcanlogin: false,
      },
    ]);
    expect(
      (
        await admin.query(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = ANY($1::text[])`,
          [[schema.APP_ROLE, schema.AUTH_ROLE, schema.IDENTITY_PROVISIONER_ROLE]],
        )
      ).rows,
    ).toEqual([]);
    expect((await auth.pool.query('SELECT current_user AS name')).rows).toEqual([
      { name: schema.AUTH_ROLE },
    ]);
    expect(
      (
        await admin.query(`SELECT pg_has_role($1, $2, 'MEMBER') AS member`, [
          schema.AUTH_ROLE,
          schema.APP_ROLE,
        ])
      ).rows,
    ).toEqual([{ member: false }]);
  });

  it('forces identity RLS and keeps credential tables outside the workspace schema', async () => {
    const result = await admin.query(
      `SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped) AS has_workspace
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY c.relname`,
      [['users', 'sessions', 'accounts', 'verifications', 'two_factors', 'auth_rate_limits']],
    );
    expect(result.rows).toEqual(
      ['accounts', 'auth_rate_limits', 'sessions', 'two_factors', 'users', 'verifications'].map(
        (name) => ({
          name,
          enabled: true,
          forced: true,
          has_workspace: false,
        }),
      ),
    );
  });

  it('gives the application only its bound user profile and fails closed without a user', async () => {
    expect(await app.db.select({ id: schema.users.id }).from(schema.users)).toEqual([]);
    expect(
      await app.withUser(a.id, (tx) => tx.select({ id: schema.users.id }).from(schema.users)),
    ).toEqual([{ id: a.id }]);
    expect(
      await app.withUser(b.id, (tx) => tx.select({ id: schema.users.id }).from(schema.users)),
    ).toEqual([{ id: b.id }]);
    expect(
      await app.withUser(a.id, (tx) =>
        tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, b.id)),
      ),
    ).toEqual([]);
    expect(
      await app.withWorkspace(workspaceId, (tx) =>
        tx.select({ id: schema.users.id }).from(schema.users),
      ),
    ).toEqual([]);
  });

  it('does not permit the application to create or change even its own identity', async () => {
    const attempts = [
      () =>
        app.db.insert(schema.users).values({
          name: 'Synthetic intruder fixture',
          email: `intruder-${crypto.randomUUID()}@example.test`,
        }),
      () =>
        app.withUser(a.id, (tx) =>
          tx.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, a.id)),
        ),
      () => app.withUser(a.id, (tx) => tx.delete(schema.users).where(eq(schema.users.id, a.id))),
    ];
    for (const attempt of attempts) expect(await errorCode(attempt)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      only(
        await auth.db
          .select({ emailVerified: schema.users.emailVerified })
          .from(schema.users)
          .where(eq(schema.users.id, a.id)),
      ).emailVerified,
    ).toBe(false);
  });

  it('allows only the auth role to read and modify credential records', async () => {
    expect(
      await auth.db
        .select({ userId: schema.sessions.userId })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, a.id)),
    ).toEqual([{ userId: a.id }]);
    expect(
      await auth.db
        .select({ userId: schema.accounts.userId })
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, a.id)),
    ).toEqual([{ userId: a.id }]);
    expect(
      await auth.db
        .select({ userId: schema.twoFactors.userId })
        .from(schema.twoFactors)
        .where(eq(schema.twoFactors.userId, a.id)),
    ).toEqual([{ userId: a.id }]);
    expect(
      await auth.db
        .select({ id: schema.verifications.id })
        .from(schema.verifications)
        .where(eq(schema.verifications.id, verificationId)),
    ).toEqual([{ id: verificationId }]);
    await auth.db
      .update(schema.authRateLimits)
      .set({ count: 2 })
      .where(eq(schema.authRateLimits.id, rateLimitId));
    expect(
      await auth.db
        .select({ count: schema.authRateLimits.count })
        .from(schema.authRateLimits)
        .where(eq(schema.authRateLimits.id, rateLimitId)),
    ).toEqual([{ count: 2 }]);
    for (const table of [
      'sessions',
      'accounts',
      'verifications',
      'two_factors',
      'auth_rate_limits',
    ]) {
      expect(
        await errorCode(() => app.db.execute(sql`SELECT * FROM ${sql.identifier(table)}`)),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        await errorCode(() =>
          app.withUser(a.id, (tx) => tx.execute(sql`SELECT * FROM ${sql.identifier(table)}`)),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(
      await errorCode(() =>
        app.db
          .insert(schema.accounts)
          .values({ userId: a.id, accountId: a.id, providerId: 'synthetic-provider-fixture' }),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await errorCode(() =>
        app.db
          .insert(schema.authRateLimits)
          .values({ key: 'synthetic-forged-rate-limit', count: 0, lastRequest: Date.now() }),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('does not give the identity role access to research data even with a workspace bound', async () => {
    for (const table of [
      'workspaces',
      'memberships',
      'projects',
      'sources',
      'files',
      'chunks',
      'documents',
      'claims',
    ]) {
      expect(
        await errorCode(() =>
          auth.withWorkspace(
            workspaceId,
            (tx) => tx.execute(sql`SELECT * FROM ${sql.identifier(table)}`),
            { userId: a.id },
          ),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await errorCode(() => auth.pool.query('SET ROLE bahith_app'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await errorCode(() => auth.pool.query('SET ROLE bahith_identity_provisioner'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('creates exactly one personal workspace and owner membership with the user name', async () => {
    const visible = await app.withUser(a.id, async (tx) => ({
      spaces: await tx
        .select({
          id: schema.workspaces.id,
          name: schema.workspaces.name,
          kind: schema.workspaces.kind,
          createdBy: schema.workspaces.createdBy,
        })
        .from(schema.workspaces),
      memberships: await tx
        .select({
          workspaceId: schema.memberships.workspaceId,
          userId: schema.memberships.userId,
          role: schema.memberships.role,
        })
        .from(schema.memberships),
    }));
    expect(visible.spaces).toEqual([
      { id: workspaceId, name: a.name, kind: 'personal', createdBy: a.id },
    ]);
    expect(visible.memberships).toEqual([{ workspaceId, userId: a.id, role: 'owner' }]);
  });

  it('provisions in the user transaction so rollback leaves neither identity nor workspace', async () => {
    const id = crypto.randomUUID();
    await expect(
      auth.db.transaction(async (tx) => {
        await tx.insert(schema.users).values({
          id,
          name: 'Synthetic rolled-back identity fixture',
          email: `rollback-${id}@example.test`,
        });
        throw new Error('synthetic transaction rollback');
      }),
    ).rejects.toThrow('synthetic transaction rollback');
    const counts = await admin.query(
      `SELECT (SELECT count(*) FROM users WHERE id = $1)::int AS users,
              (SELECT count(*) FROM workspaces WHERE created_by = $1)::int AS workspaces,
              (SELECT count(*) FROM memberships WHERE user_id = $1)::int AS memberships`,
      [id],
    );
    expect(counts.rows).toEqual([{ users: 0, workspaces: 0, memberships: 0 }]);
  });

  it('restores existing transaction context and leaves the pooled auth connection unbound', async () => {
    const previousUser = crypto.randomUUID();
    const previousWorkspace = crypto.randomUUID();
    await auth.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.user_id', ${previousUser}, true), set_config('app.workspace_id', ${previousWorkspace}, true)`,
      );
      await tx.insert(schema.users).values({
        name: 'Synthetic context restoration fixture',
        email: `context-${crypto.randomUUID()}@example.test`,
      });
      const result = await tx.execute(
        sql`SELECT current_setting('app.user_id', true) AS user_id, current_setting('app.workspace_id', true) AS workspace_id`,
      );
      expect(result.rows).toEqual([{ user_id: previousUser, workspace_id: previousWorkspace }]);
    });
    expect(
      (
        await auth.pool.query(
          `SELECT nullif(current_setting('app.user_id', true), '') IS NULL AS no_user, nullif(current_setting('app.workspace_id', true), '') IS NULL AS no_workspace`,
        )
      ).rows,
    ).toEqual([{ no_user: true, no_workspace: true }]);
  });

  it('uses a restricted definer with a fixed search path and no direct application execution', async () => {
    const definition = await admin.query(
      `SELECT p.prosecdef AS definer, r.rolname AS owner, p.proconfig AS config FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner WHERE n.nspname = 'app' AND p.proname = 'provision_personal_workspace'`,
    );
    const row = only(
      z
        .array(z.object({ definer: z.boolean(), owner: z.string(), config: z.array(z.string()) }))
        .parse(definition.rows),
    );
    expect(row.definer).toBe(true);
    expect(row.owner).toBe(schema.IDENTITY_PROVISIONER_ROLE);
    expect(
      row.config.some((entry) => entry.startsWith('search_path=') && entry.includes('pg_catalog')),
    ).toBe(true);
    expect(
      (
        await admin.query(
          `SELECT has_function_privilege($1, 'app.provision_personal_workspace()', 'EXECUTE') AS allowed`,
          [schema.APP_ROLE],
        )
      ).rows,
    ).toEqual([{ allowed: false }]);
    expect(await errorCode(() => app.pool.query('SELECT app.provision_personal_workspace()'))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('cascades deleted auth records without granting research privileges to the auth role', async () => {
    const user = only(
      await auth.db
        .insert(schema.users)
        .values({
          name: 'Synthetic deletion fixture',
          email: `delete-${crypto.randomUUID()}@example.test`,
        })
        .returning({ id: schema.users.id }),
    );
    const token = `synthetic-deleted-session-${crypto.randomUUID()}`;
    await auth.db
      .insert(schema.sessions)
      .values({ userId: user.id, token, expiresAt: new Date(Date.now() + 3_600_000) });
    await auth.db
      .insert(schema.accounts)
      .values({ userId: user.id, accountId: user.id, providerId: 'credential' });
    await auth.db.insert(schema.twoFactors).values({
      userId: user.id,
      secret: 'synthetic-delete-secret',
      backupCodes: 'synthetic-delete-codes',
    });
    await auth.db.delete(schema.users).where(eq(schema.users.id, user.id));
    for (const table of ['users', 'sessions', 'accounts', 'two_factors', 'memberships']) {
      const key = table === 'users' ? 'id' : 'user_id';
      const result = await admin.query(`SELECT count(*) AS n FROM "${table}" WHERE "${key}" = $1`, [
        user.id,
      ]);
      expect(countRow.parse(result.rows[0]).n).toBe(0);
    }
  });
});
