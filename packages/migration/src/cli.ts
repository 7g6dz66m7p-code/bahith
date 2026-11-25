import { parseArgs } from 'node:util';

import { loadDumpIntoContainer } from './inspect';
import { loadMapping } from './mapping';
import { dryRun } from './planner';
import { buildReport, writeReport } from './report';
import type { LegacySource } from './source';
import { JsonDumpSource } from './sources/json';
import { MysqlLegacySource } from './sources/mysql';
import { PostgresLegacySource } from './sources/postgres';

/**
 * Dry run only:
 *   pnpm --filter @bahith/migration dry-run -- --source=json:./dump.json --mapping=./mapping.json --out=./out
 *   LEGACY_DATABASE_URL=... pnpm --filter @bahith/migration dry-run -- --source=postgres --mapping=... --out=...
 * The legacy connection string is read from the environment, never from argv (shell
 * history). Output contains counts, legacy ids and reason codes only.
 */
const USAGE =
  'usage: dry-run --source=dump:<file.sql>|json:<path>|postgres|mysql --mapping=<path> --out=<dir> [--since=<ISO date>]\n';

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--'),
    options: {
      source: { type: 'string' },
      mapping: { type: 'string' },
      out: { type: 'string' },
      since: { type: 'string' },
    },
    strict: true,
  });
  if (values.source === undefined || values.mapping === undefined || values.out === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const mapping = await loadMapping(values.mapping);
  let source: LegacySource;
  let disposable: { stop(): Promise<unknown> } | undefined;
  if (values.source.startsWith('dump:')) {
    // The legacy MySQL dump file itself, loaded into a throwaway MariaDB container that is
    // removed afterwards; read through the same read-only MySQL source.
    const loaded = await loadDumpIntoContainer(values.source.slice('dump:'.length));
    disposable = loaded.container;
    source = new MysqlLegacySource({ connectionString: loaded.uri, mapping });
  } else if (values.source.startsWith('json:')) {
    source = await JsonDumpSource.fromFile(values.source.slice('json:'.length), mapping);
  } else if (values.source === 'postgres') {
    const url = process.env['LEGACY_DATABASE_URL'];
    if (url === undefined || url === '') {
      process.stderr.write('LEGACY_DATABASE_URL is not set (read-only replica URL required)\n');
      return 2;
    }
    source = new PostgresLegacySource({ connectionString: url, mapping });
  } else if (values.source === 'mysql') {
    const url = process.env['LEGACY_DATABASE_URL'];
    if (url === undefined || !url.startsWith('mysql://')) {
      process.stderr.write('LEGACY_DATABASE_URL must be a mysql:// URL (read-only copy)\n');
      return 2;
    }
    source = new MysqlLegacySource({ connectionString: url, mapping });
  } else {
    process.stderr.write(USAGE);
    return 2;
  }
  const since = values.since === undefined ? undefined : new Date(values.since);
  if (since !== undefined && Number.isNaN(since.getTime())) {
    process.stderr.write('--since must be an ISO date\n');
    return 2;
  }
  try {
    const plan = await dryRun(source, mapping, since === undefined ? {} : { since });
    const report = buildReport(plan, {
      generatedAt: new Date().toISOString(),
      sourceKind: source.kind,
      mode: 'dry-run',
    });
    const paths = await writeReport(report, values.out);
    const totals = Object.entries(report.counts)
      .map(
        ([e, c]) =>
          `${e}: ${c.accepted}/${c.read} accepted, ${c.rejected} rejected, ${c.conflict} conflict`,
      )
      .join('\n');
    process.stdout.write(`${totals}\nreport: ${paths.json}\nreport: ${paths.markdown}\n`);
    return 0;
  } finally {
    await source.close();
    await disposable?.stop();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Error class and message only: driver errors can echo row values, so no stack/detail.
    const name = error instanceof Error ? error.name : 'Error';
    process.stderr.write(`dry-run failed: ${name}\n`);
    process.exitCode = 1;
  },
);
