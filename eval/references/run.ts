/**
 * Runs `verifyReference` (packages/scholarly) live over eval/references/dataset.json and
 * reports how well fabricated references are detected.
 *
 *   SCHOLARLY_CONTACT_EMAIL=bahith-dev@example.org NODE_USE_ENV_PROXY=1 \
 *     pnpm --filter @bahith/eval exec tsx references/run.ts [--concurrency 3] [--crossref-only]
 *
 * Every item is checked against the live Crossref and OpenAlex APIs through the package's own
 * clients (per-host rate limits, retries, User-Agent). No response cache is configured, so
 * every run asks the registries afresh; earlier results are never read back.
 *
 * `--crossref-only` runs the supported Crossref-only configuration (no OpenAlex fallback or
 * second opinion). It is a diagnostic for when OpenAlex is unavailable (e.g. the anonymous
 * daily budget is spent); it is labelled as such in every output and never replaces the
 * default two-provider run.
 *
 * Writes results/latest.json and results/latest.md (results/latest-crossref-only.* with the
 * flag). Exit code: 0 when every target is met,
 * 1 when a target is missed (including any unverifiable item), 2 on a configuration error.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createScholarlyClients,
  isScholarlyError,
  loadScholarlyConfig,
  type FetchLike,
  type ReferenceCandidate,
  type ScholarlyConfig,
  type VerificationDeps,
  type VerificationResult,
  verifyReference,
} from '../../packages/scholarly/src/index';
import {
  DATASET_PATH,
  KINDS,
  parseDataset,
  RESULTS_DIR,
  writeLine,
  type DatasetItem,
  type Kind,
  type RunStatus,
} from './lib';

const STATUSES: RunStatus[] = ['verified', 'mismatch', 'not_found', 'unverifiable', 'error'];

interface ItemResult {
  id: string;
  kind: Kind;
  expected: string;
  status: RunStatus;
  pass: boolean;
  reasons: string[];
  provider?: string;
  matchedDoi?: string;
  checks?: VerificationResult['checks'];
  /** Error code when verifyReference threw (never a message with request data). */
  error?: string;
  durationMs: number;
}

interface Target {
  name: string;
  value: string;
  target: string;
  met: boolean;
}

function candidateOf(item: DatasetItem): ReferenceCandidate {
  const { input } = item;
  const candidate: ReferenceCandidate = { title: input.title, authors: input.authors };
  if (input.doi !== undefined) candidate.doi = input.doi;
  if (input.year !== undefined) candidate.year = input.year;
  if (input.container !== undefined) candidate.container = input.container;
  return candidate;
}

class ConfigError extends Error {}

/**
 * HTTP outcome counts per host and route kind ("api.openalex.org list 429": 25). Only the host,
 * route kind and status or error name are kept: never URLs, query text or bodies.
 */
type HttpTally = Record<string, number>;

function countingFetch(tally: HttpTally): FetchLike {
  return async (input, init) => {
    const url = new URL(input);
    // "list" = search/sample routes (/works?…), "record" = one identifier (/works/{doi}).
    const host = `${url.host} ${url.pathname.split('/').filter(Boolean).length > 1 ? 'record' : 'list'}`;
    try {
      const response = await fetch(input, init);
      const key = `${host} ${response.status}`;
      tally[key] = (tally[key] ?? 0) + 1;
      return response;
    } catch (error) {
      const key = `${host} ${error instanceof Error ? error.name : 'error'}`;
      tally[key] = (tally[key] ?? 0) + 1;
      throw error;
    }
  };
}

async function evaluate(item: DatasetItem, deps: VerificationDeps): Promise<ItemResult> {
  const started = performance.now();
  const base = { id: item.id, kind: item.kind, expected: item.expected };
  try {
    const result = await verifyReference(candidateOf(item), deps);
    const out: ItemResult = {
      ...base,
      status: result.status,
      pass: item.accepted.some((status) => status === result.status),
      reasons: result.reasons,
      checks: result.checks,
      durationMs: Math.round(performance.now() - started),
    };
    if (result.provider !== undefined) out.provider = result.provider;
    if (result.matchedRecord?.item.DOI !== undefined)
      out.matchedDoi = result.matchedRecord.item.DOI;
    return out;
  } catch (error) {
    if (isScholarlyError(error, 'SCHOLARLY_CONFIG_MISSING')) throw new ConfigError(error.message);
    return {
      ...base,
      status: 'error',
      pass: false,
      reasons: [],
      error: isScholarlyError(error) ? error.code : error instanceof Error ? error.name : 'Unknown',
      durationMs: Math.round(performance.now() - started),
    };
  }
}

async function runAll(
  items: DatasetItem[],
  deps: VerificationDeps,
  concurrency: number,
): Promise<ItemResult[]> {
  const results = new Array<ItemResult>(items.length);
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      const result = await evaluate(item, deps);
      results[index] = result;
      done += 1;
      writeLine(
        process.stderr,
        `[${String(done).padStart(3)}/${items.length}] ${result.id.padEnd(12)} ${result.status.padEnd(12)} ${result.pass ? 'pass' : 'FAIL'}`,
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

const percent = (n: number, d: number): string =>
  d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;

function summarize(results: ItemResult[]) {
  const byKind = Object.fromEntries(
    KINDS.map((kind) => {
      const rows = results.filter((r) => r.kind === kind);
      const counts = Object.fromEntries(
        STATUSES.map((status) => [status, rows.filter((r) => r.status === status).length]),
      ) as Record<RunStatus, number>;
      return [kind, { total: rows.length, pass: rows.filter((r) => r.pass).length, ...counts }];
    }),
  ) as Record<Kind, { total: number; pass: number } & Record<RunStatus, number>>;

  const real = byKind.real;
  const fab = byKind.fabricated;
  const mis = byKind.mismatched;
  const falseAcceptances = results.filter((r) => r.kind !== 'real' && r.status === 'verified');
  const incomplete = results.filter((r) => r.status === 'unverifiable' || r.status === 'error');
  const fabRejected = fab.not_found + fab.mismatch;
  const targets: Target[] = [
    {
      name: 'Real references verified',
      value: `${real.verified}/${real.total} (${percent(real.verified, real.total)})`,
      target: '100%',
      met: real.total > 0 && real.verified === real.total,
    },
    {
      name: 'Fabricated references rejected (not_found or mismatch)',
      value: `${fabRejected}/${fab.total} (${percent(fabRejected, fab.total)})`,
      target: '100%',
      met: fab.total > 0 && fabRejected === fab.total,
    },
    {
      name: 'False acceptances (fabricated or mismatched marked verified)',
      value: String(falseAcceptances.length),
      target: '0',
      met: falseAcceptances.length === 0,
    },
    {
      name: 'Mismatched references detected as mismatch',
      value: `${mis.mismatch}/${mis.total} (${percent(mis.mismatch, mis.total)})`,
      target: '100%',
      met: mis.total > 0 && mis.mismatch === mis.total,
    },
    {
      name: 'Unverifiable or errored items (provider failures; never a pass)',
      value: String(incomplete.length),
      target: '0',
      met: incomplete.length === 0,
    },
  ];
  const fabricatedExact = results.filter(
    (r) => r.kind === 'fabricated' && r.status === 'not_found',
  ).length;
  return { byKind, targets, falseAcceptances, incomplete, fabricatedExact };
}

function markdown(
  meta: {
    startedAt: string;
    finishedAt: string;
    datasetGeneratedAt: string;
    node: string;
    providers: string;
  },
  summary: ReturnType<typeof summarize>,
  results: ItemResult[],
  http: HttpTally,
): string {
  const lines: string[] = [];
  lines.push('# Fabricated-reference detection — live run', '');
  lines.push(
    `Run live (providers: **${meta.providers}**${meta.providers === 'crossref' ? ' — diagnostic Crossref-only configuration' : ''}) from ${meta.startedAt} to ${meta.finishedAt} (Node ${meta.node}). Dataset generated ${meta.datasetGeneratedAt}. No response cache.`,
    '',
  );
  lines.push('| Kind | Total | verified | mismatch | not_found | unverifiable | error | pass |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const kind of KINDS) {
    const k = summary.byKind[kind];
    lines.push(
      `| ${kind} | ${k.total} | ${k.verified} | ${k.mismatch} | ${k.not_found} | ${k.unverifiable} | ${k.error} | ${k.pass} |`,
    );
  }
  lines.push('', '| Metric | Value | Target | Met |', '| --- | --- | --- | --- |');
  for (const t of summary.targets) {
    lines.push(`| ${t.name} | ${t.value} | ${t.target} | ${t.met ? 'yes' : 'NO'} |`);
  }
  lines.push(
    '',
    `Fabricated items answered exactly \`not_found\`: ${summary.fabricatedExact}/${summary.byKind.fabricated.total}.`,
  );
  lines.push('', '| HTTP attempts (host, route, status) | Count |', '| --- | --- |');
  for (const [key, count] of Object.entries(http).sort()) lines.push(`| ${key} | ${count} |`);
  const failures = results.filter((r) => !r.pass);
  lines.push('', `## Failing items (${failures.length})`, '');
  if (failures.length === 0) lines.push('None.');
  for (const r of failures) {
    lines.push(
      `- \`${r.id}\` (${r.kind}): expected ${r.expected}, got **${r.status}**${r.error === undefined ? '' : ` (${r.error})`}; reasons: ${r.reasons.join(', ') || '—'}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<number> {
  const flag = process.argv.indexOf('--concurrency');
  const concurrency = flag === -1 ? 3 : Number(process.argv[flag + 1]);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
    writeLine(process.stderr, '--concurrency must be an integer between 1 and 10.');
    return 2;
  }
  let config: ScholarlyConfig;
  try {
    config = loadScholarlyConfig(process.env);
  } catch (error) {
    writeLine(process.stderr, error instanceof Error ? error.message : 'Invalid configuration.');
    return 2;
  }
  if (config.contactEmail === undefined) {
    writeLine(process.stderr, 'SCHOLARLY_CONTACT_EMAIL is required (e.g. bahith-dev@example.org).');
    return 2;
  }
  const dataset = parseDataset(JSON.parse(await readFile(DATASET_PATH, 'utf8')));
  const http: HttpTally = {};
  const clients = createScholarlyClients(config, { fetch: countingFetch(http) });
  const crossrefOnly = process.argv.includes('--crossref-only');
  const providers = crossrefOnly ? 'crossref' : 'crossref+openalex';
  const deps: VerificationDeps = crossrefOnly
    ? { crossref: clients.crossref }
    : { crossref: clients.crossref, openalex: clients.openalex };

  const startedAt = new Date().toISOString();
  writeLine(
    process.stderr,
    `Live run over ${dataset.items.length} references (providers ${providers}, concurrency ${concurrency}) at ${startedAt}`,
  );
  let results: ItemResult[];
  try {
    results = await runAll(dataset.items, deps, concurrency);
  } catch (error) {
    if (error instanceof ConfigError) {
      writeLine(process.stderr, error.message);
      return 2;
    }
    throw error;
  }
  const finishedAt = new Date().toISOString();
  const summary = summarize(results);
  const meta = {
    startedAt,
    finishedAt,
    datasetGeneratedAt: dataset.generatedAt,
    node: process.version,
    providers,
  };
  const md = markdown(meta, summary, results, http);

  const stem = crossrefOnly ? 'latest-crossref-only' : 'latest';
  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(
    join(RESULTS_DIR, `${stem}.json`),
    `${JSON.stringify(
      {
        ...meta,
        live: true,
        cache: 'none',
        openAlexApiKey: config.openAlexApiKey !== undefined,
        http,
        concurrency,
        byKind: summary.byKind,
        targets: summary.targets,
        results,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(RESULTS_DIR, `${stem}.md`), md);
  process.stdout.write(md);
  return summary.targets.every((t) => t.met) ? 0 : 1;
}

process.exitCode = await main();
