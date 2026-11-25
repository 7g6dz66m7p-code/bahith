/**
 * Records real upstream responses as unit-test fixtures (test/fixtures/).
 *
 *   SCHOLARLY_CONTACT_EMAIL=bahith-dev@example.org pnpm --filter @bahith/scholarly record-fixtures
 *
 * Every request goes through the real clients (same URLs as production, same rate limits),
 * with a fetch wrapper that saves each final response body. The contact email and any API key
 * are stripped from stored URLs (sanitizeUrl) and scrubbed from stored bodies; the script
 * fails if either would remain. Re-run it whenever a client changes the URLs it requests.
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  createScholarlyClients,
  isScholarlyError,
  loadScholarlyConfig,
  sanitizeUrl,
  type FetchLike,
} from '../src/index';
import { CANDIDATES } from '../test/candidates';

const FIXTURE_DIR = resolve(import.meta.dirname, '../test/fixtures');
const PLACEHOLDER_EMAIL = 'bahith-dev@example.org';

interface ManifestEntry {
  file: string;
  url: string;
  status: number;
  contentType: string | null;
  recordedAt: string;
}

const config = loadScholarlyConfig();
if (config.contactEmail === undefined) {
  process.stderr.write('SCHOLARLY_CONTACT_EMAIL is required (use bahith-dev@example.org).\n');
  process.exit(1);
}
const secrets = [
  config.contactEmail,
  config.openAlexApiKey,
  config.semanticScholarApiKey,
  config.ncbiApiKey,
].filter((value): value is string => value !== undefined && value !== PLACEHOLDER_EMAIL);

function scrub(text: string): string {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
  return result;
}

function extensionFor(contentType: string | null): string {
  if (contentType === null) return 'txt';
  if (contentType.includes('json')) return 'json';
  if (contentType.includes('xml')) return 'xml';
  return 'txt';
}

const manifest: Record<string, ManifestEntry> = {};
let currentName = '';
/** Last response of the running step; written only once the step's outcome is known. */
interface Staged {
  entry: ManifestEntry;
  body: string;
}
const stage: { current?: Staged } = {};
const takeStaged = (): Staged | undefined => {
  const staged = stage.current;
  delete stage.current;
  return staged;
};

const recordingFetch: FetchLike = async (input, init) => {
  const response = await fetch(input, init);
  const body = await response.text();
  const contentType = response.headers.get('content-type');
  const file = `${currentName}.${extensionFor(contentType)}`;
  const entry: ManifestEntry = {
    file,
    url: sanitizeUrl(new URL(input)),
    status: response.status,
    contentType,
    recordedAt: new Date().toISOString(),
  };
  for (const secret of secrets) {
    if (entry.url.includes(secret)) throw new Error('A secret would be stored in a fixture URL.');
  }
  stage.current = { entry, body: scrub(body) };
  const headers = new Headers();
  if (contentType !== null) headers.set('content-type', contentType);
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) headers.set('retry-after', retryAfter);
  return new Response(body, { status: response.status, headers });
};

const clients = createScholarlyClients(config, {
  fetch: recordingFetch,
  timeoutMs: 20_000,
  maxRetryAfterMs: 120_000,
});

type Step = [name: string, call: () => Promise<unknown>];

const steps: Step[] = [
  ['crossref-work-nature14539', () => clients.crossref.getWork(CANDIDATES.real.doi)],
  ['crossref-work-fabricated', () => clients.crossref.getWork(CANDIDATES.fabricatedDoi.doi)],
  [
    'crossref-search-real-title',
    () => clients.crossref.searchWorks(CANDIDATES.realTitleOnlyQuery, { rows: 5 }),
  ],
  [
    'crossref-search-fabricated-title',
    () => clients.crossref.searchWorks(CANDIDATES.fabricatedTitleQuery, { rows: 5 }),
  ],
  ['openalex-work-nature14539', () => clients.openalex.getWorkByDoi(CANDIDATES.real.doi)],
  ['openalex-work-fabricated', () => clients.openalex.getWorkByDoi(CANDIDATES.fabricatedDoi.doi)],
  [
    'openalex-search-fabricated-title',
    () => clients.openalex.searchWorks(CANDIDATES.fabricatedTitle.title, { perPage: 5 }),
  ],
  [
    'semanticscholar-paper-attention',
    () => clients.semanticScholar.getPaper('DOI:10.48550/arXiv.1706.03762'),
  ],
  [
    'semanticscholar-paper-nature14539',
    () => clients.semanticScholar.getPaper(`DOI:${CANDIDATES.real.doi}`),
  ],
  [
    'semanticscholar-search-attention',
    () => clients.semanticScholar.searchPapers('attention is all you need', { limit: 3 }),
  ],
  [
    'pubmed-esearch-deep-learning',
    () => clients.pubmed.esearch('deep learning[Title] AND LeCun Y[Author]', { retmax: 5 }),
  ],
  ['pubmed-esummary-26017442', () => clients.pubmed.getByPmid('26017442')],
  ['pubmed-esummary-unknown', () => clients.pubmed.getByPmid('9999999999')],
  ['arxiv-id-1706.03762', () => clients.arxiv.getById('1706.03762')],
  ['arxiv-id-unknown', () => clients.arxiv.getById('2401.99999')],
  [
    'arxiv-search-attention',
    () => clients.arxiv.search('attention is all you need', { maxResults: 3, field: 'ti' }),
  ],
  [
    'doaj-search-deep-learning',
    () => clients.doaj.searchArticles('deep learning', { pageSize: 3 }),
  ],
  ['orcid-person-carberry', () => clients.orcid.getPerson('0000-0002-1825-0097')],
  ['orcid-works-carberry', () => clients.orcid.getWorks('0000-0002-1825-0097')],
  ['unpaywall-nature14539', () => clients.unpaywall.getOpenAccess(CANDIDATES.real.doi)],
  ['unpaywall-fabricated', () => clients.unpaywall.getOpenAccess(CANDIDATES.fabricatedDoi.doi)],
];

const only = process.argv.slice(2);
await mkdir(FIXTURE_DIR, { recursive: true });
if (only.length === 0) {
  for (const file of await readdir(FIXTURE_DIR)) await rm(join(FIXTURE_DIR, file));
} else {
  // Partial re-record: keep the existing manifest entries.
  const { default: existing } = (await import(join(FIXTURE_DIR, 'manifest.json'), {
    with: { type: 'json' },
  })) as { default: { fixtures: Record<string, ManifestEntry> } };
  Object.assign(manifest, existing.fixtures);
}

let failures = 0;
for (const [name, call] of steps) {
  if (only.length > 0 && !only.includes(name)) continue;
  currentName = name;
  takeStaged();
  let outcome: string;
  let expected = true;
  try {
    await call();
    outcome = 'ok';
  } catch (error) {
    outcome = isScholarlyError(error) ? error.code : 'unexpected error';
    expected = isScholarlyError(error, 'SCHOLARLY_NOT_FOUND');
  }
  const previous = manifest[name];
  const staged = takeStaged();
  // A failed step (429, 5xx, timeout) never replaces an existing good recording.
  if (staged !== undefined && (expected || previous === undefined)) {
    manifest[name] = staged.entry;
    await writeFile(join(FIXTURE_DIR, staged.entry.file), staged.body);
  }
  if (!expected) failures += 1;
  const kept = !expected && previous !== undefined ? ' (previous recording kept)' : '';
  process.stdout.write(`${name}: HTTP ${staged?.entry.status ?? '-'} → ${outcome}${kept}\n`);
}

const ordered = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(
  join(FIXTURE_DIR, 'manifest.json'),
  `${JSON.stringify({ note: 'Recorded from the live APIs by scripts/record-fixtures.ts.', fixtures: ordered }, null, 2)}\n`,
);
process.stdout.write(
  `${Object.keys(ordered).length} fixtures, ${failures} unexpected failure(s).\n`,
);
process.exit(failures === 0 ? 0 : 1);
