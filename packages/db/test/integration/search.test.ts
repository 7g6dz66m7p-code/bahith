import { desc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/client';
import { createDatabase } from '../../src/client';
import * as schema from '../../src/schema/index';
import { arabicTsQuery } from '../../src/search';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { embeddingOf, seedWorkspace } from './fixtures';

describe('Arabic full-text search and vector search', () => {
  let database: Database;
  let admin: pg.Client;
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    const plan = z
      .object({ id: z.string() })
      .parse((await admin.query(`SELECT id FROM plans WHERE code = 'free'`)).rows[0]);
    database = createDatabase({ connectionString: inject('appUrl') });
    a = await seedWorkspace(database, 'S', plan.id);
    b = await seedWorkspace(database, 'T', plan.id);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  describe('app.normalize_arabic', () => {
    it.each([
      ['tashkeel is removed', 'الْإِحْصَاءُ', 'الاحصاء'],
      ['tatweel is removed', 'الـــعـــلم', 'العلم'],
      ['alef forms are unified', 'أحمد إبراهيم آمن ٱلله', 'احمد ابراهيم امن الله'],
      ['hamza carriers are unified', 'مسؤول شيئا', 'مسوول شييا'],
      ['alef maqsura and teh marbuta are unified', 'مستشفى مدرسة', 'مستشفي مدرسه'],
      ['Arabic-Indic digits become ASCII', 'عام ٢٠٢٤', 'عام 2024'],
      ['Persian yeh/kaf and digits are unified', 'کتابی ۱۲', 'كتابي 12'],
      ['Latin text is untouched', 'Research Methods 2024', 'Research Methods 2024'],
    ])('%s', async (_name, input, expected) => {
      const result = await database.pool.query('SELECT app.normalize_arabic($1) AS out', [input]);
      expect(result.rows).toEqual([{ out: expected }]);
    });

    it('returns NULL for NULL', async () => {
      const result = await database.pool.query('SELECT app.normalize_arabic(NULL) AS out');
      expect(result.rows).toEqual([{ out: null }]);
    });
  });

  describe('chunks.tsv', () => {
    // The fixture chunk reads: "الْإِحْصَاءُ الوصفي في دراسة S" (fully vocalised first word).
    it.each(['الإحصاء', 'الاحصاء', 'الْإِحْصَاء', 'الأحصاء الوصفى', 'دراسه'])(
      'finds the passage when searching for "%s"',
      async (query) => {
        const found = await database.withWorkspace(a.workspaceId, (tx) =>
          tx
            .select({ id: schema.chunks.id, pageStart: schema.chunks.pageStart })
            .from(schema.chunks)
            .where(sql`${schema.chunks.tsv} @@ ${arabicTsQuery(query)}`),
        );
        expect(found).toEqual([{ id: a.chunkId, pageStart: 3 }]);
      },
    );

    it('does not match unrelated words', async () => {
      const found = await database.withWorkspace(a.workspaceId, (tx) =>
        tx
          .select({ id: schema.chunks.id })
          .from(schema.chunks)
          .where(sql`${schema.chunks.tsv} @@ ${arabicTsQuery('الكيمياء')}`),
      );
      expect(found).toEqual([]);
    });

    it('treats the search string as data, not as SQL', async () => {
      const found = await database.withWorkspace(a.workspaceId, (tx) =>
        tx
          .select({ id: schema.chunks.id })
          .from(schema.chunks)
          .where(sql`${schema.chunks.tsv} @@ ${arabicTsQuery(`'); DROP TABLE chunks; --`)}`),
      );
      expect(found).toEqual([]);
      const result = await admin.query(`SELECT to_regclass('public.chunks') IS NOT NULL AS ok`);
      expect(result.rows).toEqual([{ ok: true }]);
    });

    it('is maintained by the database when the content changes', async () => {
      const chunkId = await database.withWorkspace(a.workspaceId, async (tx) => {
        const [row] = await tx
          .insert(schema.chunks)
          .values({
            workspaceId: a.workspaceId,
            sourceId: a.sourceId,
            chunkIndex: 1,
            content: 'منهج البحث النوعي',
          })
          .returning({ id: schema.chunks.id });
        await tx
          .update(schema.chunks)
          .set({ content: 'تحليل المحتوى' })
          .where(eq(schema.chunks.id, row?.id ?? ''));
        return row?.id;
      });

      const search = (query: string) =>
        database.withWorkspace(a.workspaceId, (tx) =>
          tx
            .select({ id: schema.chunks.id })
            .from(schema.chunks)
            .where(sql`${schema.chunks.tsv} @@ ${arabicTsQuery(query)}`),
        );
      expect(await search('النوعي')).toEqual([]);
      expect(await search('المحتوي')).toEqual([{ id: chunkId }]);
    });
  });

  describe('chunks constraints (academic integrity)', () => {
    it('rejects an abstract-only passage that carries a page number', async () => {
      await expect(
        database.withWorkspace(a.workspaceId, (tx) =>
          tx.insert(schema.chunks).values({
            workspaceId: a.workspaceId,
            sourceId: a.sourceId,
            kind: 'abstract',
            chunkIndex: 7,
            pageStart: 1,
            pageEnd: 1,
            content: 'ملخص',
          }),
        ),
      ).rejects.toMatchObject({ cause: { constraint: 'chunks_abstract_has_no_page' } });
    });

    it('rejects an embedding whose model is unknown', async () => {
      await expect(
        database.withWorkspace(a.workspaceId, (tx) =>
          tx.insert(schema.chunks).values({
            workspaceId: a.workspaceId,
            sourceId: a.sourceId,
            chunkIndex: 8,
            content: 'نص',
            embedding: embeddingOf(1),
          }),
        ),
      ).rejects.toMatchObject({ cause: { constraint: 'chunks_embedding_has_model' } });
    });

    it('rejects a source marked verified without a provider and a date', async () => {
      await expect(
        database.withWorkspace(a.workspaceId, (tx) =>
          tx.insert(schema.sources).values({
            workspaceId: a.workspaceId,
            origin: 'manual',
            type: 'book',
            title: 'كتاب',
            verificationStatus: 'verified',
          }),
        ),
      ).rejects.toMatchObject({ cause: { constraint: 'sources_verified_has_provider' } });
    });
  });

  describe('chunks.embedding', () => {
    it('answers nearest-neighbour queries inside the bound workspace only', async () => {
      const target = `[${embeddingOf('T'.charCodeAt(0)).join(',')}]`;
      // The query vector is exactly B's embedding, but A is bound: only A's chunks return.
      const nearest = await database.withWorkspace(a.workspaceId, (tx) =>
        tx
          .select({ workspaceId: schema.chunks.workspaceId })
          .from(schema.chunks)
          .where(sql`${schema.chunks.embedding} is not null`)
          .orderBy(sql`${schema.chunks.embedding} <=> ${target}::vector`)
          .limit(5),
      );
      expect(nearest).toEqual([{ workspaceId: a.workspaceId }]);

      const own = await database.withWorkspace(b.workspaceId, (tx) =>
        tx
          .select({
            id: schema.chunks.id,
            distance: sql<number>`${schema.chunks.embedding} <=> ${target}::vector`,
          })
          .from(schema.chunks)
          .orderBy(desc(schema.chunks.createdAt))
          .limit(1),
      );
      expect(own[0]?.id).toBe(b.chunkId);
      expect(Number(own[0]?.distance)).toBeCloseTo(0, 5);
    });

    it('rejects vectors of the wrong dimension', async () => {
      await expect(
        database.withWorkspace(a.workspaceId, (tx) =>
          tx.insert(schema.chunks).values({
            workspaceId: a.workspaceId,
            sourceId: a.sourceId,
            chunkIndex: 9,
            content: 'نص',
            embedding: [0.1, 0.2, 0.3],
            embeddingModel: 'test-embedding',
          }),
        ),
      ).rejects.toThrow();
    });
  });
});
