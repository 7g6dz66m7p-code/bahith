import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/index';
import {
  AssistantError,
  createDatabase,
  finishAssistantRun,
  getProjectAiConsent,
  saveAssistantExchange,
  setProjectAiConsent,
  startAssistantRun,
} from '../../src/index';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { seedWorkspace } from './fixtures';

const run = {
  agent: 'grounded-answer',
  promptVersion: 'grounded-answer@1',
  provider: 'anthropic',
  model: 'test-model',
};

describe('assistant: consent, quota and grounded records', () => {
  let database: Database;
  let admin: pg.Client;
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;
  const ctx = () => ({ userId: a.userId, workspaceId: a.workspaceId, projectId: a.projectId });

  async function setLimit(workspaceId: string, limits: Record<string, number>) {
    await admin.query(
      `UPDATE plans SET limits = $2::jsonb WHERE id = (SELECT plan_id FROM subscriptions WHERE workspace_id = $1)`,
      [workspaceId, JSON.stringify(limits)],
    );
  }

  beforeAll(async () => {
    database = createDatabase({ connectionString: inject('appUrl') });
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    // A dedicated plan per workspace so limits can be changed without touching others.
    const planOf = async (code: string) =>
      z
        .object({ id: z.string() })
        .parse(
          (
            await admin.query(
              `INSERT INTO plans (code, name, limits) VALUES ($1, $1, '{}'::jsonb) RETURNING id`,
              [code],
            )
          ).rows[0],
        ).id;
    a = await seedWorkspace(database, 'AssistA', await planOf(`assist-a-${crypto.randomUUID()}`));
    b = await seedWorkspace(database, 'AssistB', await planOf(`assist-b-${crypto.randomUUID()}`));
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it('refuses to start without consent, then records consent with an audit entry', async () => {
    await setLimit(a.workspaceId, { ai_requests_per_month: 5 });
    await expect(startAssistantRun(database, ctx(), run)).rejects.toEqual(
      new AssistantError('AI_CONSENT_REQUIRED'),
    );
    expect((await getProjectAiConsent(database, ctx())).enabled).toBe(false);
    await setProjectAiConsent(database, ctx(), true);
    expect((await getProjectAiConsent(database, ctx())).enabled).toBe(true);
    const audit = await admin.query(
      `SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'project.ai_consent%'`,
      [a.projectId],
    );
    expect(audit.rows).toEqual([{ action: 'project.ai_consent_granted' }]);
  });

  it('fails closed when the plan sets no limit for model requests', async () => {
    await setLimit(a.workspaceId, {});
    await expect(startAssistantRun(database, ctx(), run)).rejects.toEqual(
      new AssistantError('AI_QUOTA_NOT_CONFIGURED'),
    );
    await setLimit(a.workspaceId, { ai_requests_per_month: 0 });
    await expect(startAssistantRun(database, ctx(), run)).rejects.toEqual(
      new AssistantError('AI_QUOTA_EXCEEDED'),
    );
  });

  it('reserves one request per run up to the monthly limit, and records the outcome', async () => {
    await setLimit(a.workspaceId, { ai_requests_per_month: 2 });
    const now = new Date('2026-11-21T10:00:00Z');
    const first = await startAssistantRun(database, ctx(), run, now);
    expect(first).toMatchObject({ used: 1, limit: 2 });
    const second = await startAssistantRun(database, ctx(), run, now);
    expect(second.used).toBe(2);
    await expect(startAssistantRun(database, ctx(), run, now)).rejects.toEqual(
      new AssistantError('AI_QUOTA_EXCEEDED'),
    );
    // A new month starts a new counter.
    expect(
      (await startAssistantRun(database, ctx(), run, new Date('2026-12-01T00:00:00Z'))).used,
    ).toBe(1);

    await finishAssistantRun(database, ctx(), first.runId, {
      status: 'succeeded',
      inputTokens: 1200,
      outputTokens: 300,
      latencyMs: 2500,
      errorCode: null,
    });
    await expect(
      finishAssistantRun(database, ctx(), first.runId, {
        status: 'failed',
        inputTokens: null,
        outputTokens: null,
        latencyMs: null,
        errorCode: 'AI_TIMEOUT',
      }),
    ).rejects.toEqual(new AssistantError('AI_RUN_NOT_FOUND'));
    const row = await admin.query(
      `SELECT status, input_tokens, output_tokens, prompt_version FROM agent_runs WHERE id = $1`,
      [first.runId],
    );
    expect(row.rows).toEqual([
      {
        status: 'succeeded',
        input_tokens: 1200,
        output_tokens: 300,
        prompt_version: 'grounded-answer@1',
      },
    ]);
  });

  it('stores the exchange with one claim per sentence linked to its verified passages', async () => {
    await setLimit(a.workspaceId, { ai_requests_per_month: 50 });
    const { runId } = await startAssistantRun(
      database,
      ctx(),
      run,
      new Date('2026-12-02T00:00:00Z'),
    );
    const saved = await saveAssistantExchange(database, ctx(), {
      conversationId: null,
      runId,
      question: 'ما أثر التعلم المدمج؟',
      answer: {
        status: 'answered',
        sentences: [
          {
            text: 'ارتفع التحصيل.',
            support: 'supported',
            evidence: [{ chunkId: a.chunkId, quote: 'نص' }],
          },
          { text: 'قد يعود ذلك إلى التفاعل.', support: 'unsupported', evidence: [] },
        ],
      },
    });
    expect(saved.claimIds).toHaveLength(2);
    const stored = await admin.query(
      `SELECT c.position, c.support_status, count(e.id)::int AS evidence
         FROM claims c LEFT JOIN claim_evidence e ON e.claim_id = c.id
        WHERE c.message_id = $1 GROUP BY c.id ORDER BY c.position`,
      [saved.messageId],
    );
    expect(stored.rows).toEqual([
      { position: 0, support_status: 'supported', evidence: 1 },
      { position: 1, support_status: 'unsupported', evidence: 0 },
    ]);
    // A follow-up in the same conversation.
    const next = await saveAssistantExchange(database, ctx(), {
      conversationId: saved.conversationId,
      runId,
      question: 'سؤال آخر',
      answer: { status: 'abstained', sentences: [] },
    });
    expect(next.conversationId).toBe(saved.conversationId);
  });

  it('a workspace without a subscription uses the free plan limits', async () => {
    await admin.query('DELETE FROM subscriptions WHERE workspace_id = $1', [b.workspaceId]);
    const ctxB = { userId: b.userId, workspaceId: b.workspaceId, projectId: b.projectId };
    await setProjectAiConsent(database, ctxB, true);
    const free = await admin.query(`SELECT limits FROM plans WHERE code = 'free'`);
    try {
      await admin.query(`UPDATE plans SET limits = '{}'::jsonb WHERE code = 'free'`);
      await expect(startAssistantRun(database, ctxB, run)).rejects.toEqual(
        new AssistantError('AI_QUOTA_NOT_CONFIGURED'),
      );
      await admin.query(
        `UPDATE plans SET limits = '{"ai_requests_per_month": 1}'::jsonb WHERE code = 'free'`,
      );
      expect((await startAssistantRun(database, ctxB, run)).limit).toBe(1);
    } finally {
      await admin.query(`UPDATE plans SET limits = $1::jsonb WHERE code = 'free'`, [
        JSON.stringify(
          z.object({ limits: z.record(z.string(), z.number()) }).parse(free.rows[0]).limits,
        ),
      ]);
    }
  });

  it('cannot cite a passage of another workspace or act in another project', async () => {
    const { runId } = await startAssistantRun(
      database,
      ctx(),
      run,
      new Date('2026-12-03T00:00:00Z'),
    );
    await expect(
      saveAssistantExchange(database, ctx(), {
        conversationId: null,
        runId,
        question: 'q',
        answer: {
          status: 'answered',
          sentences: [
            { text: 't', support: 'supported', evidence: [{ chunkId: b.chunkId, quote: 'x' }] },
          ],
        },
      }),
    ).rejects.toThrow();
    const intruder = { userId: b.userId, workspaceId: a.workspaceId, projectId: a.projectId };
    await expect(setProjectAiConsent(database, intruder, false)).rejects.toMatchObject({
      code: 'SANAD_FORBIDDEN',
    });
    await expect(startAssistantRun(database, intruder, run)).rejects.toMatchObject({
      code: 'SANAD_FORBIDDEN',
    });
  });
});
