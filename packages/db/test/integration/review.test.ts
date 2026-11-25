import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/client';
import { createDatabase } from '../../src/client';
import { createDocument, getDocument, saveDocument } from '../../src/documents';
import {
  acceptSuggestion,
  addComment,
  addSuggestion,
  listComments,
  rejectSuggestion,
  resolveComment,
} from '../../src/review';
import { textAt } from '../../src/review-anchor';
import * as schema from '../../src/schema/index';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { seedWorkspace } from './fixtures';

/** Content of a one-paragraph draft: "<h1>الفصل</h1><p>{text}</p>". The text starts at 8. */
const draft = (text: string) => ({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'الفصل' }] },
    { type: 'paragraph', content: [{ type: 'text', text }] },
  ],
});
const TEXT_START = 8;
const SENTENCE = 'تعتمد الدراسة على المنهج الوصفي في تحليل البيانات';

/** The anchor of `quote` in `text`, as the editor would send it. */
function anchorOf(text: string, quote: string, versionNumber: number) {
  const offset = text.indexOf(quote);
  if (offset < 0) throw new Error('quote not in text');
  return {
    versionNumber,
    from: TEXT_START + offset,
    to: TEXT_START + offset + quote.length,
    quote,
  };
}

type Role = 'editor' | 'viewer' | 'supervisor';

describe('draft review: comments and suggested changes', () => {
  let database: Database;
  let admin: pg.Client;
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;
  const members: Record<Role, string> = { editor: '', viewer: '', supervisor: '' };

  const ctx = (userId: string) => ({
    userId,
    workspaceId: a.workspaceId,
    projectId: a.projectId,
    userName: 'مراجع',
  });
  const owner = () => ctx(a.userId);
  const as = (role: Role) => ctx(members[role]);

  /** A new draft of the owner with SENTENCE saved as version 2. */
  async function draftWithSentence(): Promise<string> {
    const { id } = await createDocument(database, owner(), { title: 'مسودة للمراجعة' });
    await saveDocument(database, owner(), id, { content: draft(SENTENCE), baseVersion: 1 });
    return id;
  }

  async function suggest(documentId: string, quote: string, replacement: string, version = 2) {
    return addSuggestion(database, as('supervisor'), documentId, {
      anchor: anchorOf(SENTENCE, quote, version),
      replacement,
      body: 'اقتراح صياغة',
    });
  }

  beforeAll(async () => {
    database = createDatabase({ connectionString: inject('appUrl') });
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    const plan = z
      .object({ id: z.string() })
      .parse((await admin.query(`SELECT id FROM plans WHERE code = 'free'`)).rows[0]);
    a = await seedWorkspace(database, 'ReviewA', plan.id);
    b = await seedWorkspace(database, 'ReviewB', plan.id);
    // Three more people, each with a personal workspace, join A's workspace with a role.
    for (const role of ['editor', 'viewer', 'supervisor'] as const) {
      const fixture = await seedWorkspace(database, `Review${role}`, plan.id);
      members[role] = fixture.userId;
      await database.withWorkspace(a.workspaceId, (tx) =>
        tx
          .insert(schema.memberships)
          .values({ workspaceId: a.workspaceId, userId: fixture.userId, role }),
      );
    }
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it('a supervisor comments and suggests; every member sees the notes with author and role', async () => {
    const id = await draftWithSentence();
    const comment = await addComment(database, as('supervisor'), id, {
      anchor: anchorOf(SENTENCE, 'المنهج الوصفي', 2),
      body: '  وضّح سبب اختيار المنهج  ',
    });
    expect(comment).toMatchObject({
      kind: 'comment',
      status: 'open',
      body: 'وضّح سبب اختيار المنهج',
      suggestion: null,
      authorId: members.supervisor,
      authorName: 'مراجع',
      authorRole: 'supervisor',
    });
    const suggestion = await suggest(id, 'تحليل البيانات', 'تحليل بيانات الاستبانة');
    expect(suggestion).toMatchObject({
      kind: 'suggestion',
      suggestion: { replacement: 'تحليل بيانات الاستبانة' },
    });
    for (const reader of [owner(), as('editor'), as('viewer'), as('supervisor')]) {
      const notes = await listComments(database, reader, id);
      expect(notes.map((note) => note.id)).toEqual([comment.id, suggestion.id]);
    }
  });

  it('owners and editors may also comment; viewers may not', async () => {
    const id = await draftWithSentence();
    const anchor = anchorOf(SENTENCE, 'الدراسة', 2);
    await expect(
      addComment(database, owner(), id, { anchor, body: 'ملاحظة المالك' }),
    ).resolves.toMatchObject({ authorRole: 'owner' });
    await expect(
      addComment(database, as('editor'), id, { anchor, body: 'ملاحظة المحرر' }),
    ).resolves.toMatchObject({ authorRole: 'editor' });
    await expect(
      addComment(database, as('viewer'), id, { anchor, body: 'ملاحظة' }),
    ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
    await expect(
      addSuggestion(database, as('viewer'), id, { anchor, replacement: 'بديل' }),
    ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
  });

  it('a supervisor reads the draft but cannot save content or decide on suggestions', async () => {
    const id = await draftWithSentence();
    await expect(getDocument(database, as('supervisor'), id)).resolves.toMatchObject({
      version: 2,
    });
    await expect(
      saveDocument(database, as('supervisor'), id, { content: draft('تعديل'), baseVersion: 2 }),
    ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
    const suggestion = await suggest(id, 'المنهج الوصفي', 'المنهج التجريبي');
    for (const role of ['supervisor', 'viewer'] as const) {
      await expect(
        acceptSuggestion(database, as(role), id, suggestion.id, { baseVersion: 2 }),
      ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
      await expect(rejectSuggestion(database, as(role), id, suggestion.id)).rejects.toMatchObject({
        code: 'SANAD_FORBIDDEN',
      });
    }
    expect((await getDocument(database, owner(), id)).version).toBe(2);
  });

  it('accepting applies the replacement as a new version and records who accepted', async () => {
    const id = await draftWithSentence();
    const suggestion = await suggest(id, 'المنهج الوصفي', 'المنهج الوصفي التحليلي');
    const accepted = await acceptSuggestion(database, as('editor'), id, suggestion.id, {
      baseVersion: 2,
    });
    const expected = SENTENCE.replace('المنهج الوصفي', 'المنهج الوصفي التحليلي');
    expect(accepted.version).toBe(3);
    expect(accepted.content).toEqual(draft(expected));
    expect(accepted.comment).toMatchObject({ status: 'accepted', appliedVersion: 3 });
    const latest = await getDocument(database, owner(), id);
    expect(latest).toMatchObject({ version: 3, kind: 'manual' });
    expect(latest.content).toEqual(draft(expected));

    const row = await admin.query(
      `SELECT resolved_by, resolved_at IS NOT NULL AS closed FROM document_comments WHERE id = $1`,
      [suggestion.id],
    );
    expect(row.rows).toEqual([{ resolved_by: members.editor, closed: true }]);
    // Deciding twice is refused.
    await expect(
      acceptSuggestion(database, owner(), id, suggestion.id, { baseVersion: 3 }),
    ).rejects.toMatchObject({ code: 'REVIEW_INVALID_STATE' });
    await expect(rejectSuggestion(database, owner(), id, suggestion.id)).rejects.toMatchObject({
      code: 'REVIEW_INVALID_STATE',
    });
  });

  it('follows a quote that moved in a later version', async () => {
    const id = await draftWithSentence();
    const suggestion = await suggest(id, 'تحليل البيانات', 'تحليل النتائج');
    const moved = `مقدمة قصيرة. ${SENTENCE}`;
    await saveDocument(database, owner(), id, { content: draft(moved), baseVersion: 2 });
    const accepted = await acceptSuggestion(database, owner(), id, suggestion.id, {
      baseVersion: 3,
    });
    expect(accepted.content).toEqual(draft(moved.replace('تحليل البيانات', 'تحليل النتائج')));
  });

  it('refuses a stale anchor with REVIEW_ANCHOR_STALE and never guesses', async () => {
    const id = await draftWithSentence();
    const gone = await suggest(id, 'المنهج الوصفي', 'المنهج المختلط');
    const ambiguous = await suggest(id, 'تحليل البيانات', 'تحليل الإجابات');
    const edited = 'تعتمد الدراسة على منهج مختلط في تحليل البيانات وفي تحليل البيانات الثانوية';
    await saveDocument(database, owner(), id, { content: draft(edited), baseVersion: 2 });

    for (const note of [gone, ambiguous]) {
      await expect(
        acceptSuggestion(database, owner(), id, note.id, { baseVersion: 3 }),
      ).rejects.toMatchObject({ code: 'REVIEW_ANCHOR_STALE' });
    }
    // Nothing changed: no new version, and the suggestions are still open.
    const latest = await getDocument(database, owner(), id);
    expect(latest.version).toBe(3);
    expect(latest.content).toEqual(draft(edited));
    const notes = await listComments(database, owner(), id);
    expect(notes.map((note) => note.status)).toEqual(['open', 'open']);
    // The owner can still decline them.
    await expect(rejectSuggestion(database, owner(), id, gone.id)).resolves.toMatchObject({
      status: 'rejected',
      appliedVersion: null,
    });
  });

  it('refuses an accept based on an outdated version', async () => {
    const id = await draftWithSentence();
    const suggestion = await suggest(id, 'الدراسة', 'هذه الدراسة');
    await saveDocument(database, owner(), id, {
      content: draft(`${SENTENCE}.`),
      baseVersion: 2,
    });
    await expect(
      acceptSuggestion(database, owner(), id, suggestion.id, { baseVersion: 2 }),
    ).rejects.toMatchObject({ code: 'SANAD_VERSION_CONFLICT' });
    expect((await getDocument(database, owner(), id)).version).toBe(3);
  });

  it('checks every anchor against the stored version it names', async () => {
    const id = await draftWithSentence();
    const anchor = anchorOf(SENTENCE, 'الدراسة', 2);
    expect(textAt(draft(SENTENCE), anchor.from, anchor.to)).toBe('الدراسة');
    const wrongQuote = { ...anchor, quote: 'الدراسه' };
    const missingVersion = { ...anchor, versionNumber: 9 };
    // Version 1 is the empty first version: the quote is not there.
    const olderVersion = { ...anchor, versionNumber: 1 };
    for (const bad of [wrongQuote, missingVersion, olderVersion]) {
      await expect(
        addComment(database, as('supervisor'), id, { anchor: bad, body: 'ملاحظة' }),
      ).rejects.toMatchObject({ code: 'REVIEW_ANCHOR_INVALID' });
    }
    for (const input of [
      { anchor: { ...anchor, to: anchor.to + 1 }, body: 'طول غير مطابق' },
      { anchor, body: '   ' },
      { anchor, body: 'x'.repeat(5001) },
      { anchor, body: 'ملاحظة', authorId: a.userId },
    ]) {
      await expect(addComment(database, as('supervisor'), id, input)).rejects.toMatchObject({
        code: 'SANAD_INVALID_INPUT',
      });
    }
    await expect(
      addSuggestion(database, as('supervisor'), id, { anchor, replacement: 'الدراسة' }),
    ).rejects.toMatchObject({ code: 'SANAD_INVALID_INPUT' });
    await expect(
      addSuggestion(database, as('supervisor'), id, { anchor, replacement: 'سطر\nجديد' }),
    ).rejects.toMatchObject({ code: 'SANAD_INVALID_INPUT' });
  });

  it('resolves comments (not suggestions), once', async () => {
    const id = await draftWithSentence();
    const anchor = anchorOf(SENTENCE, 'الدراسة', 2);
    const comment = await addComment(database, as('editor'), id, { anchor, body: 'ملاحظة' });
    const suggestion = await suggest(id, 'الدراسة', 'البحث');
    await expect(resolveComment(database, as('viewer'), id, comment.id)).rejects.toMatchObject({
      code: 'SANAD_FORBIDDEN',
    });
    await expect(resolveComment(database, as('supervisor'), id, comment.id)).resolves.toMatchObject(
      { status: 'resolved' },
    );
    await expect(resolveComment(database, owner(), id, comment.id)).rejects.toMatchObject({
      code: 'REVIEW_INVALID_STATE',
    });
    await expect(resolveComment(database, owner(), id, suggestion.id)).rejects.toMatchObject({
      code: 'REVIEW_INVALID_STATE',
    });
  });

  it('audits review actions with ids only, never the quoted or suggested text', async () => {
    const id = await draftWithSentence();
    const suggestion = await suggest(id, 'المنهج الوصفي', 'نص مقترح سري');
    await acceptSuggestion(database, owner(), id, suggestion.id, { baseVersion: 2 });
    const result = await admin.query(
      `SELECT action, metadata FROM audit_log
       WHERE entity_id = $1 AND action LIKE 'document.suggestion%' ORDER BY created_at`,
      [id],
    );
    expect(result.rows).toEqual([
      { action: 'document.suggestion_added', metadata: { commentId: suggestion.id } },
      {
        action: 'document.suggestion_accepted',
        metadata: { commentId: suggestion.id, version: 3 },
      },
    ]);
    const all = await admin.query(
      `SELECT metadata::text AS m FROM audit_log WHERE entity_id = $1`,
      [id],
    );
    for (const row of z.array(z.object({ m: z.string() })).parse(all.rows)) {
      expect(row.m).not.toContain('سري');
      expect(row.m).not.toContain('المنهج');
    }
  });

  it('isolates review notes between workspaces, projects and documents', async () => {
    const id = await draftWithSentence();
    const anchor = anchorOf(SENTENCE, 'الدراسة', 2);
    const comment = await addComment(database, as('supervisor'), id, { anchor, body: 'خاص' });
    const suggestion = await suggest(id, 'الدراسة', 'البحث');

    // B is not a member of A's workspace.
    const intruder = { ...ctx(b.userId) };
    await expect(listComments(database, intruder, id)).rejects.toMatchObject({
      code: 'SANAD_FORBIDDEN',
    });
    await expect(
      addComment(database, intruder, id, { anchor, body: 'دخيل' }),
    ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
    await expect(
      acceptSuggestion(database, intruder, id, suggestion.id, { baseVersion: 2 }),
    ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
    await expect(resolveComment(database, intruder, id, comment.id)).rejects.toMatchObject({
      code: 'SANAD_FORBIDDEN',
    });

    // In B's own workspace, A's document and notes do not exist.
    const own = { userId: b.userId, workspaceId: b.workspaceId, projectId: b.projectId };
    await expect(listComments(database, own, id)).rejects.toMatchObject({
      code: 'SANAD_FILE_NOT_FOUND',
    });
    await expect(
      acceptSuggestion(database, own, b.documentId, suggestion.id, { baseVersion: 1 }),
    ).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
    await expect(resolveComment(database, own, b.documentId, comment.id)).rejects.toMatchObject({
      code: 'REVIEW_NOT_FOUND',
    });

    // A note is only reachable through its own document.
    const other = await draftWithSentence();
    await expect(resolveComment(database, owner(), other, comment.id)).rejects.toMatchObject({
      code: 'REVIEW_NOT_FOUND',
    });
    expect(await listComments(database, owner(), other)).toEqual([]);

    // A's draft in another of A's projects is not reachable through this project.
    const [project] = await database.withWorkspace(a.workspaceId, (tx) =>
      tx
        .insert(schema.projects)
        .values({ workspaceId: a.workspaceId, title: 'مشروع آخر' })
        .returning({ id: schema.projects.id }),
    );
    if (project === undefined) throw new Error('expected a project');
    await expect(
      listComments(database, { ...owner(), projectId: project.id }, id),
    ).rejects.toMatchObject({ code: 'SANAD_FILE_NOT_FOUND' });
  });
});
