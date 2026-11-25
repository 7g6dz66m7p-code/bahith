import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/client';
import { createDatabase } from '../../src/client';
import {
  addHighlight,
  addSourceToCollection,
  createCollection,
  deleteCollection,
  deleteHighlight,
  listCollections,
  listHighlights,
  removeSourceFromCollection,
  renameCollection,
  updateHighlightNote,
} from '../../src/collections';
import { addReferenceSource } from '../../src/library';
import * as schema from '../../src/schema/index';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { seedWorkspace } from './fixtures';

type Role = 'editor' | 'viewer' | 'supervisor';

/** The fixture passage of workspace `label` (see fixtures.ts). */
const passage = (label: string) => `الْإِحْصَاءُ الوصفي في دراسة ${label}`;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const parsed = z.object({ code: z.string() }).safeParse(error);
    if (parsed.success) return parsed.data.code;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('library organisation: collections and highlights', () => {
  let database: Database;
  let admin: pg.Client;
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;
  /** A second project of workspace A, without A's fixture source attached. */
  let otherProjectId: string;
  const members: Record<Role, string> = { editor: '', viewer: '', supervisor: '' };

  const ctx = (userId: string, projectId = a.projectId) => ({
    userId,
    workspaceId: a.workspaceId,
    projectId,
  });
  const owner = () => ctx(a.userId);
  const as = (role: Role) => ctx(members[role]);

  beforeAll(async () => {
    database = createDatabase({ connectionString: inject('appUrl') });
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    const plan = z
      .object({ id: z.string() })
      .parse((await admin.query(`SELECT id FROM plans WHERE code = 'free'`)).rows[0]);
    a = await seedWorkspace(database, 'LibA', plan.id);
    b = await seedWorkspace(database, 'LibB', plan.id);
    for (const role of ['editor', 'viewer', 'supervisor'] as const) {
      const fixture = await seedWorkspace(database, `Lib${role}`, plan.id);
      members[role] = fixture.userId;
      await database.withWorkspace(a.workspaceId, (tx) =>
        tx
          .insert(schema.memberships)
          .values({ workspaceId: a.workspaceId, userId: fixture.userId, role }),
      );
    }
    otherProjectId = z
      .object({ id: z.string() })
      .parse(
        (
          await database.withWorkspace(a.workspaceId, (tx) =>
            tx
              .insert(schema.projects)
              .values({ workspaceId: a.workspaceId, title: 'مشروع آخر' })
              .returning({ id: schema.projects.id }),
          )
        )[0],
      ).id;
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  describe('collections', () => {
    it('owners and editors create, rename and fill collections; every member reads them', async () => {
      const methods = await createCollection(database, owner(), { name: '  المنهجية  ' });
      expect(methods.name).toBe('المنهجية');
      const chapter = await createCollection(database, as('editor'), { name: 'Chapter 2' });
      expect(await addSourceToCollection(database, as('editor'), methods.id, a.sourceId)).toEqual({
        added: true,
      });
      // Adding twice changes nothing.
      expect(await addSourceToCollection(database, owner(), methods.id, a.sourceId)).toEqual({
        added: false,
      });
      await renameCollection(database, as('editor'), chapter.id, { name: 'الفصل الثاني' });

      for (const reader of [owner(), as('editor'), as('viewer'), as('supervisor')]) {
        const list = await listCollections(database, reader);
        expect(list.find((c) => c.id === methods.id)).toMatchObject({
          name: 'المنهجية',
          sourceIds: [a.sourceId],
          sourceCount: 1,
        });
        expect(list.find((c) => c.id === chapter.id)).toMatchObject({
          name: 'الفصل الثاني',
          sourceCount: 0,
        });
      }

      expect(
        await removeSourceFromCollection(database, as('editor'), methods.id, a.sourceId),
      ).toEqual({ removed: true });
      const after = await listCollections(database, owner());
      expect(after.find((c) => c.id === methods.id)?.sourceCount).toBe(0);
      // The source itself stays in the library.
      const linked = await admin.query(
        `SELECT 1 FROM project_sources WHERE project_id = $1 AND source_id = $2`,
        [a.projectId, a.sourceId],
      );
      expect(linked.rowCount).toBe(1);

      await deleteCollection(database, owner(), chapter.id);
      expect((await listCollections(database, owner())).some((c) => c.id === chapter.id)).toBe(
        false,
      );
    });

    it('viewers and supervisors cannot change collections', async () => {
      const { id } = await createCollection(database, owner(), { name: 'للقراءة فقط' });
      for (const role of ['viewer', 'supervisor'] as const) {
        expect(await codeOf(createCollection(database, as(role), { name: `x-${role}` }))).toBe(
          'SANAD_FORBIDDEN',
        );
        expect(await codeOf(renameCollection(database, as(role), id, { name: 'y' }))).toBe(
          'SANAD_FORBIDDEN',
        );
        expect(await codeOf(addSourceToCollection(database, as(role), id, a.sourceId))).toBe(
          'SANAD_FORBIDDEN',
        );
        expect(await codeOf(removeSourceFromCollection(database, as(role), id, a.sourceId))).toBe(
          'SANAD_FORBIDDEN',
        );
        expect(await codeOf(deleteCollection(database, as(role), id))).toBe('SANAD_FORBIDDEN');
      }
    });

    it('names are unique per project ignoring case, bounded and not blank', async () => {
      await createCollection(database, owner(), { name: 'Theory' });
      expect(await codeOf(createCollection(database, owner(), { name: 'theory' }))).toBe(
        'LIBRARY_NAME_TAKEN',
      );
      const other = await createCollection(database, owner(), { name: 'Practice' });
      expect(await codeOf(renameCollection(database, owner(), other.id, { name: 'THEORY' }))).toBe(
        'LIBRARY_NAME_TAKEN',
      );
      // The same name in another project is fine.
      await createCollection(database, ctx(a.userId, otherProjectId), { name: 'Theory' });
      for (const name of ['', '   ', 'ع'.repeat(121)]) {
        expect(await codeOf(createCollection(database, owner(), { name }))).toBe(
          'SANAD_INVALID_INPUT',
        );
      }
      expect(await codeOf(createCollection(database, owner(), { name: 'x', extra: 1 }))).toBe(
        'SANAD_INVALID_INPUT',
      );
    });

    it('only sources attached to the project can be added', async () => {
      const { id } = await createCollection(database, owner(), { name: 'مصادر خارجية' });
      // A source of the same workspace, attached to the other project only.
      const { sourceId } = await addReferenceSource(database, ctx(a.userId, otherProjectId), {
        record: { type: 'book', title: 'كتاب في مشروع آخر', doi: null },
        origin: 'import',
        verifiedBy: null,
      });
      expect(await codeOf(addSourceToCollection(database, owner(), id, sourceId))).toBe(
        'SANAD_SOURCE_MISMATCH',
      );
      // B's source id is invisible here.
      expect(await codeOf(addSourceToCollection(database, owner(), id, b.sourceId))).toBe(
        'SANAD_SOURCE_MISMATCH',
      );
      // A collection of another project is not found through this project.
      const foreign = await createCollection(database, ctx(a.userId, otherProjectId), {
        name: 'Elsewhere',
      });
      expect(await codeOf(addSourceToCollection(database, owner(), foreign.id, a.sourceId))).toBe(
        'LIBRARY_NOT_FOUND',
      );
      expect(await codeOf(deleteCollection(database, owner(), foreign.id))).toBe(
        'LIBRARY_NOT_FOUND',
      );
      expect(await codeOf(deleteCollection(database, owner(), 'not-a-uuid'))).toBe(
        'SANAD_INVALID_INPUT',
      );
    });

    it('outsiders and other workspaces see and change nothing', async () => {
      const { id } = await createCollection(database, owner(), { name: 'سري' });
      const outsider = { userId: b.userId, workspaceId: a.workspaceId, projectId: a.projectId };
      expect(await codeOf(listCollections(database, outsider))).toBe('SANAD_FORBIDDEN');
      expect(await codeOf(deleteCollection(database, outsider, id))).toBe('SANAD_FORBIDDEN');
      // B, in its own workspace, cannot reach A's collection by id.
      const inB = { userId: b.userId, workspaceId: b.workspaceId, projectId: b.projectId };
      expect(await codeOf(renameCollection(database, inB, id, { name: 'hijack' }))).toBe(
        'LIBRARY_NOT_FOUND',
      );
      expect(await codeOf(addSourceToCollection(database, inB, id, b.sourceId))).toBe(
        'LIBRARY_NOT_FOUND',
      );
      // A's project id under B's workspace is not a project at all.
      expect(
        await codeOf(
          listCollections(database, {
            userId: b.userId,
            workspaceId: b.workspaceId,
            projectId: a.projectId,
          }),
        ),
      ).toBe('SANAD_PROJECT_NOT_FOUND');
      const names = await admin.query(`SELECT name FROM collections WHERE id = $1`, [id]);
      expect(names.rows).toEqual([{ name: 'سري' }]);
    });

    it('records audit entries without the collection name', async () => {
      const { id } = await createCollection(database, owner(), { name: 'اسم لا يُسجَّل' });
      const rows = await admin.query(
        `SELECT action, metadata::text AS metadata FROM audit_log WHERE entity_id = $1`,
        [id],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ action: 'collection.created' });
      expect(JSON.stringify(rows.rows)).not.toContain('اسم لا يُسجَّل');
    });
  });

  describe('highlights', () => {
    const word = 'الْإِحْصَاءُ';

    it('an editor highlights an exact span with a note; pages come from the passage', async () => {
      const content = passage('LibA');
      const start = Array.from(content.slice(0, content.indexOf('الوصفي'))).length;
      const { id } = await addHighlight(database, as('editor'), {
        chunkId: a.chunkId,
        charStart: start,
        charEnd: start + Array.from('الوصفي').length,
        quote: 'الوصفي',
        note: '  مصطلح أساسي  ',
        color: 'green',
      });
      for (const reader of [owner(), as('viewer'), as('supervisor')]) {
        const found = (await listHighlights(database, reader)).find((h) => h.id === id);
        expect(found).toMatchObject({
          chunkId: a.chunkId,
          sourceId: a.sourceId,
          sourceTitle: 'مصدر LibA',
          fileId: a.fileId,
          pageStart: 3,
          pageEnd: 4,
          quote: 'الوصفي',
          note: 'مصطلح أساسي',
          color: 'green',
        });
      }
      const forSource = await listHighlights(database, owner(), { sourceId: a.sourceId });
      expect(forSource.some((h) => h.id === id)).toBe(true);
      const forOther = await listHighlights(database, owner(), { sourceId: b.sourceId });
      expect(forOther).toEqual([]);
    });

    it('counts offsets in code points (whole passage, diacritics, astral characters)', async () => {
      // The whole passage, as the "highlight passage" action sends it.
      const content = passage('LibA');
      const whole = await addHighlight(database, owner(), {
        chunkId: a.chunkId,
        charStart: 0,
        charEnd: Array.from(content).length,
        quote: content,
      });
      expect(whole.id).toMatch(/^[0-9a-f-]{36}$/u);

      // A passage with a character outside the BMP: UTF-16 offsets would be off by one.
      const astral = 'نص 𝔸 ثم كلمة مهمة';
      const [chunk] = await database.withWorkspace(a.workspaceId, (tx) =>
        tx
          .insert(schema.chunks)
          .values({
            workspaceId: a.workspaceId,
            sourceId: a.sourceId,
            fileId: a.fileId,
            chunkIndex: 7,
            pageStart: 9,
            pageEnd: 9,
            content: astral,
          })
          .returning({ id: schema.chunks.id }),
      );
      const chunkId = chunk?.id ?? '';
      const utf16 = astral.indexOf('كلمة');
      const points = Array.from(astral.slice(0, utf16)).length;
      expect(points).toBe(utf16 - 1);
      expect(
        await codeOf(
          addHighlight(database, owner(), {
            chunkId,
            charStart: utf16,
            charEnd: utf16 + 4,
            quote: 'كلمة',
          }),
        ),
      ).toBe('HIGHLIGHT_QUOTE_MISMATCH');
      const ok = await addHighlight(database, owner(), {
        chunkId,
        charStart: points,
        charEnd: points + 4,
        quote: 'كلمة',
      });
      const listed = (await listHighlights(database, owner())).find((h) => h.id === ok.id);
      expect(listed).toMatchObject({ pageStart: 9, charStart: points, charEnd: points + 4 });
    });

    it('refuses a quote that is not exactly the stored text at the offsets', async () => {
      const attempts = [
        // Diacritics removed: not the stored text.
        { charStart: 0, charEnd: 7, quote: 'الإحصاء' },
        // Right text, shifted offsets.
        { charStart: 1, charEnd: 13, quote: word },
        // Offsets beyond the passage.
        { charStart: 0, charEnd: 500, quote: word },
        // Text not in the passage at all.
        { charStart: 0, charEnd: 12, quote: 'تجاهل التعليمات' },
      ];
      for (const attempt of attempts) {
        expect(
          await codeOf(addHighlight(database, owner(), { chunkId: a.chunkId, ...attempt })),
        ).toBe('HIGHLIGHT_QUOTE_MISMATCH');
      }
      for (const invalid of [
        { chunkId: a.chunkId, charStart: 3, charEnd: 3, quote: '' },
        { chunkId: a.chunkId, charStart: -1, charEnd: 12, quote: word },
        { chunkId: a.chunkId, charStart: 0, charEnd: 12, quote: word, color: 'purple' },
        { chunkId: a.chunkId, charStart: 0, charEnd: 12, quote: word, note: 'ن'.repeat(5001) },
        { chunkId: a.chunkId, charStart: 0, charEnd: 12, quote: word, pageStart: 99 },
      ]) {
        expect(await codeOf(addHighlight(database, owner(), invalid))).toBe('SANAD_INVALID_INPUT');
      }
    });

    it('a passage of another project or workspace cannot be highlighted', async () => {
      // B's chunk id from A's project: not found (RLS hides it; the service checks too).
      expect(
        await codeOf(
          addHighlight(database, owner(), {
            chunkId: b.chunkId,
            charStart: 0,
            charEnd: 12,
            quote: word,
          }),
        ),
      ).toBe('LIBRARY_NOT_FOUND');
      // A's own chunk, but through the project its source is not attached to.
      expect(
        await codeOf(
          addHighlight(database, ctx(a.userId, otherProjectId), {
            chunkId: a.chunkId,
            charStart: 0,
            charEnd: 12,
            quote: word,
          }),
        ),
      ).toBe('LIBRARY_NOT_FOUND');
    });

    it('role matrix: viewers and supervisors read only; notes belong to their author', async () => {
      const ownersNote = await addHighlight(database, owner(), {
        chunkId: a.chunkId,
        charStart: 0,
        charEnd: 12,
        quote: word,
        note: 'ملاحظة المالك',
      });
      const editorsNote = await addHighlight(database, as('editor'), {
        chunkId: a.chunkId,
        charStart: 0,
        charEnd: 12,
        quote: word,
      });
      for (const role of ['viewer', 'supervisor'] as const) {
        expect(
          await codeOf(
            addHighlight(database, as(role), {
              chunkId: a.chunkId,
              charStart: 0,
              charEnd: 12,
              quote: word,
            }),
          ),
        ).toBe('SANAD_FORBIDDEN');
        expect(
          await codeOf(updateHighlightNote(database, as(role), ownersNote.id, { note: 'x' })),
        ).toBe('SANAD_FORBIDDEN');
        expect(await codeOf(deleteHighlight(database, as(role), ownersNote.id))).toBe(
          'SANAD_FORBIDDEN',
        );
        const seen = (await listHighlights(database, as(role))).find((h) => h.id === ownersNote.id);
        expect(seen).toMatchObject({ canEditNote: false, canDelete: false });
      }
      // The editor edits their own note, not the owner's; the owner may edit any.
      expect(
        await updateHighlightNote(database, as('editor'), editorsNote.id, { note: 'رأيي' }),
      ).toEqual({ id: editorsNote.id, note: 'رأيي' });
      expect(
        await codeOf(updateHighlightNote(database, as('editor'), ownersNote.id, { note: 'x' })),
      ).toBe('SANAD_FORBIDDEN');
      expect(await updateHighlightNote(database, owner(), editorsNote.id, { note: '   ' })).toEqual(
        { id: editorsNote.id, note: null },
      );
      const forEditor = await listHighlights(database, as('editor'));
      expect(forEditor.find((h) => h.id === editorsNote.id)).toMatchObject({
        note: null,
        canEditNote: true,
        canDelete: true,
      });
      expect(forEditor.find((h) => h.id === ownersNote.id)).toMatchObject({
        canEditNote: false,
        canDelete: true,
      });
      // Owners and editors may delete; the highlight is then gone for everyone.
      await deleteHighlight(database, as('editor'), ownersNote.id);
      expect((await listHighlights(database, owner())).some((h) => h.id === ownersNote.id)).toBe(
        false,
      );
      expect(await codeOf(deleteHighlight(database, owner(), ownersNote.id))).toBe(
        'LIBRARY_NOT_FOUND',
      );
    });

    it('outsiders and other workspaces cannot read or change highlights', async () => {
      const { id } = await addHighlight(database, owner(), {
        chunkId: a.chunkId,
        charStart: 0,
        charEnd: 12,
        quote: word,
        note: 'خاص',
      });
      const outsider = { userId: b.userId, workspaceId: a.workspaceId, projectId: a.projectId };
      expect(await codeOf(listHighlights(database, outsider))).toBe('SANAD_FORBIDDEN');
      expect(await codeOf(updateHighlightNote(database, outsider, id, { note: 'x' }))).toBe(
        'SANAD_FORBIDDEN',
      );
      const inB = { userId: b.userId, workspaceId: b.workspaceId, projectId: b.projectId };
      expect(await codeOf(deleteHighlight(database, inB, id))).toBe('LIBRARY_NOT_FOUND');
      expect(await codeOf(updateHighlightNote(database, inB, id, { note: 'x' }))).toBe(
        'LIBRARY_NOT_FOUND',
      );
      expect((await listHighlights(database, inB)).some((h) => h.id === id)).toBe(false);
      // Another project of the same workspace does not list it either.
      expect(
        (await listHighlights(database, ctx(a.userId, otherProjectId))).some((h) => h.id === id),
      ).toBe(false);
      const stored = await admin.query(`SELECT note FROM highlights WHERE id = $1`, [id]);
      expect(stored.rows).toEqual([{ note: 'خاص' }]);
    });

    it('the database itself refuses a quote whose length disagrees with the offsets', async () => {
      await expect(
        database.withWorkspace(a.workspaceId, (tx) =>
          tx.insert(schema.highlights).values({
            workspaceId: a.workspaceId,
            projectId: a.projectId,
            chunkId: a.chunkId,
            charStart: 0,
            charEnd: 5,
            quote: word,
          }),
        ),
      ).rejects.toThrow();
    });

    it('audit entries carry ids and flags, never the quote or note', async () => {
      const { id } = await addHighlight(database, owner(), {
        chunkId: a.chunkId,
        charStart: 0,
        charEnd: 12,
        quote: word,
        note: 'نص الملاحظة السري',
      });
      await updateHighlightNote(database, owner(), id, { note: 'نص آخر' });
      const rows = await admin.query(
        `SELECT action, metadata FROM audit_log WHERE entity_id = $1 ORDER BY created_at`,
        [id],
      );
      const actions = z.array(z.object({ action: z.string() })).parse(rows.rows);
      expect(actions.map((row) => row.action)).toEqual([
        'highlight.created',
        'highlight.note_updated',
      ]);
      const text = JSON.stringify(rows.rows);
      expect(text).not.toContain('نص الملاحظة السري');
      expect(text).not.toContain('نص آخر');
      expect(text).not.toContain(word);
    });
  });
});
