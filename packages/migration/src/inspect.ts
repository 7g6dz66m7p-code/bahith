import { stat } from 'node:fs/promises';

import { MariaDbContainer } from '@testcontainers/mariadb';
import type { StartedMariaDbContainer } from '@testcontainers/mariadb';
import mysql from 'mysql2/promise';

/**
 * Structure of a legacy MySQL/MariaDB dump, read from the database itself after loading
 * the dump into a disposable container — never guessed from table names. The report
 * holds names, types, keys, relations and counts only: no row contents (personal data).
 */
export interface DumpColumn {
  name: string;
  type: string;
  nullable: boolean;
  key: '' | 'PRI' | 'UNI' | 'MUL';
  default: string | null;
  extra: string;
  /** Rows where the column is NULL (empty-string counts for text are separate). */
  nullCount: number;
}

export interface DumpTable {
  name: string;
  engine: string | null;
  collation: string | null;
  rows: number;
  primaryKey: string[];
  columns: DumpColumn[];
  foreignKeys: {
    name: string;
    columns: string[];
    references: string;
    referencedColumns: string[];
  }[];
  /** Columns named like `<x>_id` with no declared foreign key (MyISAM dumps have none). */
  undeclaredReferences: string[];
  /** Child rows whose declared FK value has no parent row (integrity of the legacy data). */
  orphans: { foreignKey: string; rows: number }[];
}

export interface DumpReport {
  format: 'bahith-legacy-dump-report-v1';
  generatedAt: string;
  dumpBytes: number;
  dumpSha256: string;
  serverVersion: string;
  tables: DumpTable[];
}

const MAX_DUMP_BYTES = 4 * 1024 ** 3;
const quote = (name: string) => `\`${name.replace(/`/g, '``')}\``;

export async function sha256File(path: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Starts a throwaway MariaDB and loads the dump with the server's own client. */
export async function loadDumpIntoContainer(
  dumpPath: string,
  image = 'mariadb:11.4',
): Promise<{ container: StartedMariaDbContainer; uri: string; database: string }> {
  const info = await stat(dumpPath);
  if (!info.isFile() || info.size > MAX_DUMP_BYTES) throw new Error('DUMP_INVALID');
  const database = 'legacy';
  const container = await new MariaDbContainer(image)
    .withDatabase(database)
    .withCommand(['--max-allowed-packet=1G', '--character-set-server=utf8mb4'])
    .start();
  try {
    await container.copyFilesToContainer([{ source: dumpPath, target: '/tmp/legacy.sql' }]);
    const load = await container.exec([
      'sh',
      '-c',
      `mariadb --default-character-set=utf8mb4 -uroot -p"$MARIADB_ROOT_PASSWORD" ${database} < /tmp/legacy.sql`,
    ]);
    if (load.exitCode !== 0) {
      // The server's message names the failing statement/line, not row contents.
      throw new Error(`DUMP_LOAD_FAILED: ${load.stderr.split('\n').slice(0, 3).join(' ')}`);
    }
    const uri = `mysql://root:${container.getRootPassword()}@${container.getHost()}:${container.getPort()}/${database}`;
    return { container, uri, database };
  } catch (error) {
    await container.stop();
    throw error;
  }
}

/** Reads the actual schema and counts of `database` (information_schema + COUNT(*)). */
export async function inspectDatabase(
  uri: string,
  database: string,
): Promise<Omit<DumpReport, 'format' | 'generatedAt' | 'dumpBytes' | 'dumpSha256'>> {
  const connection = await mysql.createConnection({ uri, dateStrings: true, charset: 'utf8mb4' });
  try {
    await connection.query('SET SESSION TRANSACTION READ ONLY');
    const [[version]] = (await connection.query('SELECT VERSION() AS v')) as unknown as [
      { v: string }[],
    ];
    const [tableRows] = (await connection.query(
      `SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      [database],
    )) as unknown as [{ name: string; engine: string | null; collation: string | null }[]];
    const [columnRows] = (await connection.query(
      `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, COLUMN_TYPE AS type,
              IS_NULLABLE AS nullable, COLUMN_KEY AS keyKind, COLUMN_DEFAULT AS def, EXTRA AS extra
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [database],
    )) as unknown as [
      {
        tableName: string;
        name: string;
        type: string;
        nullable: string;
        keyKind: DumpColumn['key'];
        def: string | null;
        extra: string;
      }[],
    ];
    const [fkRows] = (await connection.query(
      `SELECT k.TABLE_NAME AS tableName, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col,
              k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refCol
       FROM information_schema.KEY_COLUMN_USAGE k
       WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [database],
    )) as unknown as [
      { tableName: string; name: string; col: string; refTable: string; refCol: string }[],
    ];

    const tables: DumpTable[] = [];
    for (const table of tableRows) {
      const columns = columnRows.filter((c) => c.tableName === table.name);
      const [[count]] = (await connection.query(
        `SELECT COUNT(*) AS n FROM ${quote(table.name)}`,
      )) as unknown as [{ n: number | string }[]];
      const rows = Number(count?.n ?? 0);
      const described: DumpColumn[] = [];
      for (const column of columns) {
        const [[nulls]] = (await connection.query(
          `SELECT COUNT(*) AS n FROM ${quote(table.name)} WHERE ${quote(column.name)} IS NULL`,
        )) as unknown as [{ n: number | string }[]];
        described.push({
          name: column.name,
          type: column.type,
          nullable: column.nullable === 'YES',
          key: column.keyKind,
          default: column.def,
          extra: column.extra,
          nullCount: Number(nulls?.n ?? 0),
        });
      }
      const grouped = new Map<string, DumpTable['foreignKeys'][number]>();
      for (const fk of fkRows.filter((f) => f.tableName === table.name)) {
        const entry = grouped.get(fk.name) ?? {
          name: fk.name,
          columns: [],
          references: fk.refTable,
          referencedColumns: [],
        };
        entry.columns.push(fk.col);
        entry.referencedColumns.push(fk.refCol);
        grouped.set(fk.name, entry);
      }
      const foreignKeys = [...grouped.values()];
      const declared = new Set(foreignKeys.flatMap((fk) => fk.columns));
      const orphans: DumpTable['orphans'] = [];
      for (const fk of foreignKeys) {
        const join = fk.columns
          .map((c, i) => `p.${quote(fk.referencedColumns[i] ?? '')} = c.${quote(c)}`)
          .join(' AND ');
        const notNull = fk.columns.map((c) => `c.${quote(c)} IS NOT NULL`).join(' AND ');
        const [[orphan]] = (await connection.query(
          `SELECT COUNT(*) AS n FROM ${quote(table.name)} c
           LEFT JOIN ${quote(fk.references)} p ON ${join}
           WHERE ${notNull} AND p.${quote(fk.referencedColumns[0] ?? '')} IS NULL`,
        )) as unknown as [{ n: number | string }[]];
        orphans.push({ foreignKey: fk.name, rows: Number(orphan?.n ?? 0) });
      }
      tables.push({
        name: table.name,
        engine: table.engine,
        collation: table.collation,
        rows,
        primaryKey: described.filter((c) => c.key === 'PRI').map((c) => c.name),
        columns: described,
        foreignKeys,
        undeclaredReferences: described
          .map((c) => c.name)
          .filter((name) => /_id$/iu.test(name) && !declared.has(name)),
        orphans,
      });
    }
    return { serverVersion: version?.v ?? '', tables };
  } finally {
    await connection.end();
  }
}

/** Markdown summary of the report for review (structure and counts only). */
export function renderDumpReport(report: DumpReport): string {
  const lines = [
    '# Legacy dump structure report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Dump: ${report.dumpBytes} bytes, SHA-256 \`${report.dumpSha256}\``,
    `- Loaded into: ${report.serverVersion}`,
    `- Tables: ${report.tables.length}; rows: ${report.tables.reduce((n, t) => n + t.rows, 0)}`,
    '',
    '| Table | Rows | Primary key | Foreign keys | Undeclared `_id` columns | Orphans |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.tables.map(
      (t) =>
        `| ${t.name} | ${t.rows} | ${t.primaryKey.join(', ') || '—'} | ${
          t.foreignKeys.map((fk) => `${fk.columns.join(',')}→${fk.references}`).join('; ') || '—'
        } | ${t.undeclaredReferences.join(', ') || '—'} | ${
          t.orphans.reduce((n, o) => n + o.rows, 0) || 0
        } |`,
    ),
    '',
  ];
  for (const t of report.tables) {
    lines.push(
      `## ${t.name}`,
      '',
      '| Column | Type | Null | Key | NULL rows |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const c of t.columns) {
      lines.push(
        `| ${c.name} | ${c.type} | ${c.nullable ? 'yes' : 'no'} | ${c.key || ''} | ${c.nullCount} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function inspectDump(dumpPath: string, image?: string): Promise<DumpReport> {
  const loaded = await loadDumpIntoContainer(dumpPath, image);
  try {
    const inspected = await inspectDatabase(loaded.uri, loaded.database);
    return {
      format: 'bahith-legacy-dump-report-v1',
      generatedAt: new Date().toISOString(),
      dumpBytes: (await stat(dumpPath)).size,
      dumpSha256: await sha256File(dumpPath),
      ...inspected,
    };
  } finally {
    await loaded.container.stop();
  }
}
