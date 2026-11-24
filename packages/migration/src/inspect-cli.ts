import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { inspectDump, renderDumpReport } from './inspect';

/**
 *   pnpm --filter @bahith/migration inspect-dump -- --dump=/secure/u747978280_bahith.sql --out=/secure/report
 * Loads the dump into a disposable MariaDB container (removed afterwards) and writes the
 * real structure and counts. Keep the dump and the output outside the repository.
 */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: { dump: { type: 'string' }, out: { type: 'string' }, image: { type: 'string' } },
  strict: true,
});
if (values.dump === undefined || values.out === undefined) {
  process.stderr.write(
    'usage: inspect-dump --dump=<file.sql> --out=<dir> [--image=mariadb:11.4]\n',
  );
  process.exit(2);
}
const repo = path.resolve(import.meta.dirname, '../../..');
if (path.resolve(values.out).startsWith(repo + path.sep)) {
  process.stderr.write('--out must be outside the repository (the report describes real data)\n');
  process.exit(2);
}
const report = await inspectDump(values.dump, values.image);
await mkdir(values.out, { recursive: true, mode: 0o700 });
await writeFile(path.join(values.out, 'dump-report.json'), `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
await writeFile(path.join(values.out, 'dump-report.md'), renderDumpReport(report), { mode: 0o600 });
process.stdout.write(
  `Inspected ${report.tables.length} tables (${report.tables.reduce((n, t) => n + t.rows, 0)} rows). Report in ${values.out}\n`,
);
