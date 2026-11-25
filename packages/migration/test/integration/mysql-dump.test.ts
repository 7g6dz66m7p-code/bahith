import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DumpReport } from '../../src/index';
import {
  dryRun,
  inspectDatabase,
  loadMapping,
  loadDumpIntoContainer,
  MysqlLegacySource,
  parseMapping,
  renderDumpReport,
} from '../../src/index';

const dump = fileURLToPath(new URL('../../fixtures/legacy-mysql.synthetic.sql', import.meta.url));

describe('legacy MySQL dump: real structure from the dump itself (synthetic fixture)', () => {
  let loaded: Awaited<ReturnType<typeof loadDumpIntoContainer>>;
  let report: Omit<DumpReport, 'format' | 'generatedAt' | 'dumpBytes' | 'dumpSha256'>;

  beforeAll(async () => {
    loaded = await loadDumpIntoContainer(dump);
    report = await inspectDatabase(loaded.uri, loaded.database);
  }, 300_000);

  afterAll(async () => {
    await loaded.container.stop();
  });

  it('lists every table with exact row counts, keys and declared relations', () => {
    expect(report.tables.map((t) => [t.name, t.rows, t.engine])).toEqual([
      ['members', 3, 'InnoDB'],
      ['plans_subs', 2, 'InnoDB'],
      ['transactions', 2, 'MyISAM'],
    ]);
    const subs = report.tables.find((t) => t.name === 'plans_subs');
    expect(subs?.primaryKey).toEqual(['id']);
    expect(subs?.foreignKeys).toEqual([
      {
        name: 'plans_subs_member_fk',
        columns: ['member_id'],
        references: 'members',
        referencedColumns: ['id'],
      },
    ]);
    expect(subs?.orphans).toEqual([{ foreignKey: 'plans_subs_member_fk', rows: 0 }]);
    // No declared FK on MyISAM: the `member_id` column is flagged for manual review.
    expect(report.tables.find((t) => t.name === 'transactions')?.undeclaredReferences).toEqual([
      'member_id',
    ]);
    const members = report.tables.find((t) => t.name === 'members');
    expect(members?.columns.find((c) => c.name === 'email')).toMatchObject({
      type: 'varchar(191)',
      nullable: true,
      nullCount: 1,
    });
  });

  it('the rendered report holds structure and counts, never row contents', () => {
    const text = renderDumpReport({
      format: 'bahith-legacy-dump-report-v1',
      generatedAt: '2026-11-24T00:00:00.000Z',
      dumpBytes: 1,
      dumpSha256: 'x',
      ...report,
    });
    expect(text).toContain('| members | 3 | id |');
    for (const secret of ['one@example.test', 'باحث تجريبي', '0501234567', '49.000']) {
      expect(text).not.toContain(secret);
    }
  });

  it('the read-only MySQL source reads Arabic text intact and cannot write', async () => {
    const mapping = parseMapping({
      version: 1,
      description: 'synthetic',
      defaults: { phoneCountryCode: '966', currency: 'SAR', language: 'ar', provider: 'x' },
      entities: {
        users: {
          table: 'members',
          key: 'id',
          fields: {
            legacyId: 'id',
            email: 'email',
            phone: 'mobile',
            name: 'full_name',
            createdAt: 'created_on',
            updatedAt: 'updated_on',
          },
        },
      },
    });
    const source = new MysqlLegacySource({ connectionString: loaded.uri, mapping, batchSize: 2 });
    try {
      const rows = [];
      for await (const row of source.read('users')) rows.push(row);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r['name'])).toContain('باحث تجريبي');
    } finally {
      await source.close();
    }
    const mysql = (await import('mysql2/promise')).default;
    const connection = await mysql.createConnection({ uri: loaded.uri });
    try {
      await connection.query('SET SESSION TRANSACTION READ ONLY');
      await connection.query('START TRANSACTION READ ONLY');
      await expect(connection.query('DELETE FROM members')).rejects.toMatchObject({
        code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION',
      });
    } finally {
      await connection.end();
    }
  });

  it('dry-runs the dump through the read-only source and explains every rejection', async () => {
    const mapping = await loadMapping(
      fileURLToPath(new URL('../../fixtures/mapping.synthetic-mysql.json', import.meta.url)),
    );
    const source = new MysqlLegacySource({ connectionString: loaded.uri, mapping });
    try {
      const plan = await dryRun(source, mapping);
      expect(plan.readCounts).toMatchObject({ users: 3, subscriptions: 2 });
      const reasons = plan.outcomes
        .filter((o) => o.status !== 'accepted')
        .map((o) => `${o.entity}:${o.reasons.join('+')}`)
        .sort();
      expect(reasons).toEqual([
        'subscriptions:invalid:periodEnd+invalid:periodStart',
        'subscriptions:subscription_without_payment',
        'users:missing_email',
      ]);
    } finally {
      await source.close();
    }
  });
});
