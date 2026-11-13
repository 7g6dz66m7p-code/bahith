import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadMigrations } from '../../src/migrator';

const tempDirs: string[] = [];

async function migrationsDir(files: Record<string, string>, tags: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bahith-migrations-'));
  tempDirs.push(dir);
  await mkdir(path.join(dir, 'meta'));
  await mkdir(path.join(dir, 'down'));
  await writeFile(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag })) }),
  );
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe('loadMigrations', () => {
  it('every migration in the repository has a down migration', async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((m) => m.tag)).toEqual([
      '0000_foundation',
      '0001_schema',
      '0002_security',
    ]);
    for (const migration of migrations) {
      expect(migration.downSql.trim(), migration.tag).not.toBe('');
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns migrations in journal order and strips drizzle breakpoints', async () => {
    const dir = await migrationsDir(
      {
        '0000_a.sql': 'SELECT 1;--> statement-breakpoint\nSELECT 2;',
        '0001_b.sql': 'SELECT 3;',
        'down/0000_a.sql': 'SELECT -1;',
        'down/0001_b.sql': 'SELECT -3;',
      },
      ['0000_a', '0001_b'],
    );
    const migrations = await loadMigrations(dir);
    expect(migrations.map((m) => m.tag)).toEqual(['0000_a', '0001_b']);
    expect(migrations[0]?.upSql).toBe('SELECT 1;\nSELECT 2;');
    expect(migrations[1]?.downSql).toBe('SELECT -3;');
  });

  it('fails when a migration has no down migration', async () => {
    const dir = await migrationsDir({ '0000_a.sql': 'SELECT 1;' }, ['0000_a']);
    await expect(loadMigrations(dir)).rejects.toMatchObject({
      code: 'DB_MIGRATION_MISSING_DOWN',
    });
  });

  it('gives a different checksum when the up SQL changes', async () => {
    const first = await loadMigrations(
      await migrationsDir({ '0000_a.sql': 'SELECT 1;', 'down/0000_a.sql': 'SELECT 0;' }, [
        '0000_a',
      ]),
    );
    const second = await loadMigrations(
      await migrationsDir({ '0000_a.sql': 'SELECT 2;', 'down/0000_a.sql': 'SELECT 0;' }, [
        '0000_a',
      ]),
    );
    expect(first[0]?.checksum).not.toBe(second[0]?.checksum);
  });
});
