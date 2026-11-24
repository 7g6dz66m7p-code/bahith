import { randomUUID } from 'node:crypto';

import type { Database } from '@bahith/db';
import {
  addReferenceSource,
  countEmbeddedChunks,
  createDatabase,
  createProject,
  schema,
  setProjectAiConsent,
} from '@bahith/db';
import { seedReferenceData, startTestDatabase } from '@bahith/db/testing';
import type { TestDatabase } from '@bahith/db/testing';
import { AiCallError } from '@bahith/ai';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Embedder } from '../src/embed';
import { createEmbedHandler } from '../src/embed';

/** Deterministic stand-in for the provider (test only); never used outside tests. */
function fakeEmbedder(calls: string[][], fail?: AiCallError): Embedder {
  return {
    provider: 'test',
    model: 'test-embedding',
    embed: (values) => {
      calls.push([...values]);
      if (fail !== undefined) return Promise.reject(fail);
      return Promise.resolve({
        vectors: values.map((_, n) =>
          Array.from({ length: 1024 }, (__, i) => Math.cos((n + 1) * (i + 1))),
        ),
        tokens: values.length * 10,
      });
    },
  };
}

describe('sanad.embed job', () => {
  let db: TestDatabase;
  let database: Database;
  let admin: pg.Client;
  let context: { userId: string; workspaceId: string; projectId: string };

  beforeAll(async () => {
    db = await startTestDatabase();
    admin = new pg.Client({ connectionString: db.adminUrl });
    await admin.connect();
    await seedReferenceData(admin);
    database = createDatabase({ connectionString: db.appUrl });
    const auth = createDatabase({ connectionString: db.authUrl });
    const [user] = await auth.db
      .insert(schema.users)
      .values({ email: `embed-${randomUUID()}@example.test`, name: 'Embed Test' })
      .returning({ id: schema.users.id });
    await auth.close();
    const userId = user?.id ?? '';
    const [workspace] = await database.withUser(userId, (tx) =>
      tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
    );
    const workspaceId = workspace?.id ?? '';
    const project = await createProject(database, userId, { workspaceId, title: 'مشروع التضمين' });
    context = { userId, workspaceId, projectId: project.id };
    // Three abstract passages (metadata-only sources) to embed.
    for (const title of ['أثر التعلم المدمج', 'Sleep and memory', 'فهرسة المخطوطات']) {
      const { sourceId } = await addReferenceSource(database, context, {
        record: { type: 'article-journal', title, doi: null },
        origin: 'import',
        verifiedBy: null,
      });
      await database.withWorkspace(workspaceId, (tx) =>
        tx.insert(schema.chunks).values({
          workspaceId,
          sourceId,
          kind: 'abstract',
          chunkIndex: 0,
          content: `ملخص: ${title}`,
        }),
      );
    }
  });

  afterAll(async () => {
    await admin.end();
    await database.close();
    await db.stop();
  });

  it('does nothing without a configured model, consent or quota — no provider call', async () => {
    expect(await createEmbedHandler({ database, embedder: null })(context)).toEqual({
      status: 'skipped',
      code: 'AI_EMBEDDING_NOT_CONFIGURED',
    });
    const calls: string[][] = [];
    const handler = createEmbedHandler({ database, embedder: fakeEmbedder(calls) });
    expect(await handler(context)).toEqual({ status: 'skipped', code: 'AI_CONSENT_REQUIRED' });
    await setProjectAiConsent(database, context, true);
    expect(await handler(context)).toEqual({ status: 'skipped', code: 'AI_QUOTA_NOT_CONFIGURED' });
    expect(calls).toEqual([]);
  });

  it('embeds missing passages as one counted request per batch, then finds nothing left', async () => {
    await admin.query(
      `UPDATE plans SET limits = '{"ai_requests_per_month": 10}' WHERE code = 'free'`,
    );
    const calls: string[][] = [];
    const handler = createEmbedHandler({ database, embedder: fakeEmbedder(calls) });
    expect(await handler(context)).toEqual({ status: 'done', embedded: 3 });
    expect(calls).toHaveLength(1);
    expect(await countEmbeddedChunks(database, context, 'test-embedding')).toBe(3);
    expect(await handler(context)).toEqual({ status: 'done', embedded: 0 });
    expect(calls).toHaveLength(1);
    const runs = await admin.query(
      `SELECT agent, status, input_tokens FROM agent_runs WHERE project_id = $1`,
      [context.projectId],
    );
    expect(runs.rows).toEqual([{ agent: 'embedder', status: 'succeeded', input_tokens: 30 }]);
  });

  it('a provider without credit fails the run once and is not retried', async () => {
    const calls: string[][] = [];
    const broke = fakeEmbedder(calls, new AiCallError('AI_PROVIDER_QUOTA', 429));
    const handler = createEmbedHandler({ database, embedder: { ...broke, model: 'other-model' } });
    await expect(handler(context)).rejects.toMatchObject({
      name: 'UnrecoverableError',
      message: 'AI_PROVIDER_QUOTA',
    });
    const failed = await admin.query(
      `SELECT error_code FROM agent_runs WHERE project_id = $1 AND status = 'failed'`,
      [context.projectId],
    );
    expect(failed.rows).toEqual([{ error_code: 'AI_PROVIDER_QUOTA' }]);
  });
});
