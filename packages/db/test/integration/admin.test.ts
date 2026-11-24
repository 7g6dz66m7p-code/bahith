import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/index';
import {
  createDatabase,
  getPlatformStats,
  getWorkspaceUsage,
  listPlans,
  MemberError,
  PlanError,
  setPlanAiRequestLimit,
  setProjectAiConsent,
  startAssistantRun,
} from '../../src/index';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { seedWorkspace } from './fixtures';

describe('platform administration and workspace usage', () => {
  let database: Database;
  let admin: pg.Client;
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;
  let planCode: string;

  beforeAll(async () => {
    database = createDatabase({ connectionString: inject('appUrl') });
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    planCode = `admin-test-${crypto.randomUUID().slice(0, 8)}`;
    const plan = z
      .object({ id: z.string() })
      .parse(
        (
          await admin.query(
            `INSERT INTO plans (code, name, limits) VALUES ($1, 'T', '{}') RETURNING id`,
            [planCode],
          )
        ).rows[0],
      );
    a = await seedWorkspace(database, 'AdminA', plan.id);
    b = await seedWorkspace(database, 'AdminB', plan.id);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it('platform stats are aggregate numbers only', async () => {
    const stats = await getPlatformStats(database);
    expect(stats.users).toBeGreaterThanOrEqual(2);
    expect(stats.workspaces).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(stats)).not.toMatch(/@|AdminA/u);
  });

  it('plan limits change only through the validated function', async () => {
    expect(await setPlanAiRequestLimit(database, planCode, 3)).toEqual({
      ai_requests_per_month: 3,
    });
    expect((await listPlans(database)).find((p) => p.code === planCode)?.limits).toEqual({
      ai_requests_per_month: 3,
    });
    await expect(setPlanAiRequestLimit(database, planCode, -1)).rejects.toEqual(
      new PlanError('PLAN_INVALID'),
    );
    await expect(setPlanAiRequestLimit(database, 'no-such-plan', 1)).rejects.toEqual(
      new PlanError('PLAN_NOT_FOUND'),
    );
    // The application role still cannot write plans directly.
    await expect(
      database.pool.query(`UPDATE plans SET limits = '{}' WHERE code = $1`, [planCode]),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      database.pool.query(`SELECT app.set_plan_limit($1, 'storage_bytes', 1)`, [planCode]),
    ).rejects.toThrow(/unknown plan metric/u);
  });

  it('a member sees their workspace usage against the plan; outsiders do not', async () => {
    const ctx = { userId: a.userId, workspaceId: a.workspaceId, projectId: a.projectId };
    await setProjectAiConsent(database, ctx, true);
    await startAssistantRun(database, ctx, {
      agent: 'grounded-answer',
      promptVersion: 'v',
      provider: 'p',
      model: 'm',
    });
    const usage = await getWorkspaceUsage(database, {
      userId: a.userId,
      workspaceId: a.workspaceId,
    });
    expect(usage).toMatchObject({ plan: { code: planCode }, aiRequests: { used: 1, limit: 3 } });
    expect(
      (await getWorkspaceUsage(database, { userId: b.userId, workspaceId: b.workspaceId }))
        .aiRequests.used,
    ).toBe(0);
    await expect(
      getWorkspaceUsage(database, { userId: b.userId, workspaceId: a.workspaceId }),
    ).rejects.toEqual(new MemberError('MEMBER_FORBIDDEN'));
  });
});
