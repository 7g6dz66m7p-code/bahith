import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/client';
import { createDatabase } from '../../src/client';
import {
  createDocument,
  getDocument,
  listDocuments,
  listDocumentVersions,
  saveDocument,
} from '../../src/documents';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { seedWorkspace } from './fixtures';

const doc = (text: string) => ({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'الفصل الأول' }] },
    { type: 'paragraph', content: [{ type: 'text', text }] },
  ],
});

describe('research drafts', () => {
  let database: Database;
  let admin: pg.Client;
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;
  const ctxA = () => ({ userId: a.userId, workspaceId: a.workspaceId, projectId: a.projectId });

  beforeAll(async () => {
    database = createDatabase({ connectionString: inject('appUrl') });
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    const plan = z
      .object({ id: z.string() })
      .parse((await admin.query(`SELECT id FROM plans WHERE code = 'free'`)).rows[0]);
    a = await seedWorkspace(database, 'DocsA', plan.id);
    b = await seedWorkspace(database, 'DocsB', plan.id);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it('creates a draft with an empty first version', async () => {
    const created = await createDocument(database, ctxA(), { title: 'مسودة الفصل الأول' });
    expect(created).toMatchObject({ title: 'مسودة الفصل الأول', latestVersion: 1 });
    const latest = await getDocument(database, ctxA(), created.id);
    expect(latest).toMatchObject({ version: 1, kind: 'manual' });
    expect(latest.content).toMatchObject({ type: 'doc' });
  });

  it('saves new versions, keeps every version, and preserves Arabic text exactly', async () => {
    const { id } = await createDocument(database, ctxA(), { title: 'نسخ' });
    const text = 'الْبَحْثُ العِلْمِيُّ (Research) ١٢٪';
    expect(
      await saveDocument(database, ctxA(), id, { content: doc(text), baseVersion: 1 }),
    ).toEqual({ version: 2, unchanged: false });
    expect(
      await saveDocument(database, ctxA(), id, {
        content: doc(`${text} — مراجعة`),
        baseVersion: 2,
        kind: 'manual',
      }),
    ).toEqual({ version: 3, unchanged: false });

    const versions = await listDocumentVersions(database, ctxA(), id);
    expect(versions.map((v) => [v.version, v.kind])).toEqual([
      [3, 'manual'],
      [2, 'autosave'],
      [1, 'manual'],
    ]);
    const second = await getDocument(database, ctxA(), id, 2);
    expect(JSON.stringify(second.content)).toContain(text);
    expect((await listDocuments(database, ctxA())).find((d) => d.id === id)?.latestVersion).toBe(3);
  });

  it('refuses a save based on an outdated version instead of overwriting', async () => {
    const { id } = await createDocument(database, ctxA(), { title: 'تعارض' });
    await saveDocument(database, ctxA(), id, {
      content: doc('نسخة التبويب الأول'),
      baseVersion: 1,
    });
    await expect(
      saveDocument(database, ctxA(), id, { content: doc('نسخة التبويب الثاني'), baseVersion: 1 }),
    ).rejects.toMatchObject({ code: 'SANAD_VERSION_CONFLICT' });
    expect(JSON.stringify((await getDocument(database, ctxA(), id)).content)).toContain(
      'التبويب الأول',
    );
  });

  it('does not create a version when nothing changed', async () => {
    const { id } = await createDocument(database, ctxA(), { title: 'بلا تغيير' });
    await saveDocument(database, ctxA(), id, { content: doc('ثابت'), baseVersion: 1 });
    expect(
      await saveDocument(database, ctxA(), id, { content: doc('ثابت'), baseVersion: 2 }),
    ).toEqual({ version: 2, unchanged: true });
  });

  it('serialises concurrent saves: exactly one wins per base version', async () => {
    const { id } = await createDocument(database, ctxA(), { title: 'تزامن' });
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((n) =>
        saveDocument(database, ctxA(), id, { content: doc(`محاولة ${n}`), baseVersion: 1 }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await getDocument(database, ctxA(), id)).version).toBe(2);
  });

  it.each([
    ['content that is not a document', { content: { type: 'paragraph' }, baseVersion: 1 }],
    ['a negative base version', { content: doc('x'), baseVersion: -1 }],
    ['unknown fields', { content: doc('x'), baseVersion: 1, userId: 'x' }],
  ])('rejects %s', async (_name, input) => {
    const { id } = await createDocument(database, ctxA(), { title: 'تحقق' });
    await expect(saveDocument(database, ctxA(), id, input)).rejects.toMatchObject({
      code: 'SANAD_INVALID_INPUT',
    });
  });

  it('isolates drafts between users and projects', async () => {
    const { id } = await createDocument(database, ctxA(), { title: 'خاص' });
    const outsider = { userId: b.userId, workspaceId: a.workspaceId, projectId: a.projectId };
    await expect(getDocument(database, outsider, id)).rejects.toMatchObject({
      code: 'SANAD_FORBIDDEN',
    });
    await expect(
      saveDocument(database, outsider, id, { content: doc('دخيل'), baseVersion: 1 }),
    ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
    const otherProject = { userId: b.userId, workspaceId: b.workspaceId, projectId: b.projectId };
    await expect(getDocument(database, otherProject, id)).rejects.toMatchObject({
      code: 'SANAD_FILE_NOT_FOUND',
    });
    expect(await listDocuments(database, otherProject)).not.toContainEqual(
      expect.objectContaining({ id }),
    );
  });
});
