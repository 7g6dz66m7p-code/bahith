import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/client';
import { createDatabase } from '../../src/client';
import {
  addReferenceSource,
  applySourceVerification,
  listProjectSourceMetadata,
} from '../../src/library';
import { seedReferenceData } from '../../src/seed';

import type { WorkspaceFixture } from './fixtures';
import { seedWorkspace } from './fixtures';

// Bibliographic metadata of a real publication (LeCun, Bengio & Hinton 2015).
const deepLearning = {
  type: 'article-journal',
  title: 'Deep learning',
  authors: [
    { family: 'LeCun', given: 'Yann' },
    { family: 'Bengio', given: 'Yoshua' },
    { family: 'Hinton', given: 'Geoffrey' },
  ],
  year: 2015,
  containerTitle: 'Nature',
  volume: '521',
  issue: '7553',
  pages: '436-444',
  doi: '10.1038/nature14539',
};

describe('references: registry import and verification', () => {
  let database: Database;
  let admin: pg.Client;
  let a: WorkspaceFixture;
  let b: WorkspaceFixture;
  const ctx = () => ({ userId: a.userId, workspaceId: a.workspaceId, projectId: a.projectId });

  beforeAll(async () => {
    database = createDatabase({ connectionString: inject('appUrl') });
    admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    await seedReferenceData(admin);
    const plan = z
      .object({ id: z.string() })
      .parse((await admin.query(`SELECT id FROM plans WHERE code = 'free'`)).rows[0]);
    a = await seedWorkspace(database, 'RefA', plan.id);
    b = await seedWorkspace(database, 'RefB', plan.id);
  });

  afterAll(async () => {
    await database.close();
    await admin.end();
  });

  it('adds a registry record as a verified, metadata-only source', async () => {
    const { sourceId, duplicate } = await addReferenceSource(database, ctx(), {
      record: deepLearning,
      origin: 'search',
      verifiedBy: 'crossref',
    });
    expect(duplicate).toBe(false);
    const [stored] = await listProjectSourceMetadata(database, ctx(), sourceId);
    expect(stored).toMatchObject({
      title: 'Deep learning',
      doi: '10.1038/nature14539',
      verificationStatus: 'verified',
      verificationProvider: 'crossref',
    });
    const row = await admin.query(`SELECT full_text_status FROM sources WHERE id = $1`, [sourceId]);
    expect(row.rows).toEqual([{ full_text_status: 'none' }]);
  });

  it('links the existing source when the same DOI is added again (any case)', async () => {
    const first = await addReferenceSource(database, ctx(), {
      record: { ...deepLearning, doi: '10.1234/dedup-test' },
      origin: 'search',
      verifiedBy: 'crossref',
    });
    const again = await addReferenceSource(database, ctx(), {
      record: { ...deepLearning, doi: '10.1234/DEDUP-TEST' },
      origin: 'import',
      verifiedBy: null,
    });
    expect(again).toEqual({ sourceId: first.sourceId, duplicate: true });
  });

  it('an imported record stays unverified', async () => {
    const { sourceId } = await addReferenceSource(database, ctx(), {
      record: { type: 'book', title: 'كتاب مستورد', doi: null },
      origin: 'import',
      verifiedBy: null,
    });
    const [stored] = await listProjectSourceMetadata(database, ctx(), sourceId);
    expect(stored?.verificationStatus).toBe('unverified');
  });

  it('re-importing a DOI-less record (case and spacing aside) links the existing source', async () => {
    const first = await addReferenceSource(database, ctx(), {
      record: { type: 'book', title: 'مناهج البحث  النوعي: مدخل', year: 2019, doi: null },
      origin: 'import',
      verifiedBy: null,
    });
    const again = await addReferenceSource(database, ctx(), {
      record: { type: 'book', title: ' مناهج البحث النوعي مدخل ', year: 2019, doi: null },
      origin: 'import',
      verifiedBy: null,
    });
    expect(again).toEqual({ sourceId: first.sourceId, duplicate: true });
    // A different year is a different work (e.g. another edition).
    const otherEdition = await addReferenceSource(database, ctx(), {
      record: { type: 'book', title: 'مناهج البحث النوعي: مدخل', year: 2023, doi: null },
      origin: 'import',
      verifiedBy: null,
    });
    expect(otherEdition.duplicate).toBe(false);
    // Workspace B's identical record is its own source.
    const inB = await addReferenceSource(
      database,
      { userId: b.userId, workspaceId: b.workspaceId, projectId: b.projectId },
      {
        record: { type: 'book', title: 'مناهج البحث النوعي: مدخل', year: 2019, doi: null },
        origin: 'import',
        verifiedBy: null,
      },
    );
    expect(inB.duplicate).toBe(false);
  });

  it('verification replaces metadata with the registry record; mismatch keeps it', async () => {
    const { sourceId } = await addReferenceSource(database, ctx(), {
      record: { type: 'document', title: 'deep lerning (typo)', doi: null },
      origin: 'import',
      verifiedBy: null,
    });
    await applySourceVerification(database, ctx(), sourceId, {
      status: 'mismatch',
      provider: 'crossref',
    });
    expect((await listProjectSourceMetadata(database, ctx(), sourceId))[0]).toMatchObject({
      title: 'deep lerning (typo)',
      verificationStatus: 'mismatch',
    });

    await applySourceVerification(database, ctx(), sourceId, {
      status: 'verified',
      provider: 'crossref',
      record: { ...deepLearning, doi: '10.5555/verify-apply' },
    });
    expect((await listProjectSourceMetadata(database, ctx(), sourceId))[0]).toMatchObject({
      title: 'Deep learning',
      year: 2015,
      verificationStatus: 'verified',
      verificationProvider: 'crossref',
    });
    const audit = await admin.query(
      `SELECT metadata FROM audit_log WHERE entity_id = $1 AND action = 'source.verification_checked' ORDER BY created_at`,
      [sourceId],
    );
    expect(audit.rows.map((row: { metadata: unknown }) => row.metadata)).toEqual([
      { status: 'mismatch', provider: 'crossref' },
      { status: 'verified', provider: 'crossref' },
    ]);
  });

  it('refuses an unverifiable outcome and a verified outcome without a record', async () => {
    for (const outcome of [
      { status: 'unverifiable', provider: null },
      { status: 'verified', provider: 'crossref' },
    ]) {
      await expect(
        applySourceVerification(database, ctx(), a.sourceId, outcome),
      ).rejects.toMatchObject({ code: 'SANAD_INVALID_INPUT' });
    }
  });

  it('cannot verify or read sources of another workspace or as a non-member', async () => {
    await expect(
      applySourceVerification(database, ctx(), b.sourceId, { status: 'not_found', provider: null }),
    ).rejects.toMatchObject({ code: 'SANAD_SOURCE_MISMATCH' });
    await expect(
      listProjectSourceMetadata(database, {
        userId: b.userId,
        workspaceId: a.workspaceId,
        projectId: a.projectId,
      }),
    ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
  });
});
