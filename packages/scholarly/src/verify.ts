import { isScholarlyError, ScholarlyError } from './errors';
import type { CrossrefClient } from './providers/crossref';
import type { OpenAlexClient } from './providers/openalex';
import type { CslItem, CslName, ProviderId, ScholarlyRecord, SearchResult } from './types';
import { issuedYear } from './util/csl';
import { normalizeDoi } from './util/ids';
import {
  levenshteinRatio,
  normalizeText,
  titleSimilarity,
  tokenJaccard,
  tokens,
} from './util/text';

/**
 * Decision thresholds for the fabricated-reference detector.
 *
 * TITLE_SIMILARITY_THRESHOLD — titles match when `titleSimilarity` ≥ 0.85. The score is the
 *   best of normalised token Jaccard and Levenshtein ratio over the full and main titles
 *   (see util/text.ts). 0.85 tolerates punctuation, diacritics, Arabic orthographic variants,
 *   a dropped subtitle and a few typos, while unrelated titles that share topic words
 *   ("Deep learning for X" vs "Deep learning") stay well below it.
 * YEAR_TOLERANCE — publication years match within ±1 (online-first vs print issue dates).
 * CONTAINER_* — journal names are a soft check only (abbreviations vary too much): they are
 *   reported in `checks.containerMatch` and `CONTAINER_MISMATCH`, but never change the status.
 */
export const TITLE_SIMILARITY_THRESHOLD = 0.85;
export const YEAR_TOLERANCE = 1;
export const CONTAINER_JACCARD_THRESHOLD = 0.5;
export const CONTAINER_LEVENSHTEIN_THRESHOLD = 0.8;
/** Search hits examined per provider when there is no DOI. */
export const SEARCH_ROWS = 5;

export const VERIFICATION_REASONS = [
  'DOI_MALFORMED',
  'DOI_RESOLVED',
  'DOI_NOT_FOUND',
  'TITLE_MATCH',
  'TITLE_MISMATCH',
  'YEAR_MISMATCH',
  'FIRST_AUTHOR_MISMATCH',
  'CONTAINER_MISMATCH',
  'METADATA_NOT_CHECKED',
  'SEARCH_MATCH',
  'TITLE_FOUND_WITH_OTHER_DOI',
  'NO_MATCHING_RECORD',
  'INSUFFICIENT_METADATA',
  'PROVIDER_UNAVAILABLE',
] as const;

export type VerificationReason = (typeof VERIFICATION_REASONS)[number];

export type VerificationStatus = 'verified' | 'mismatch' | 'not_found' | 'unverifiable';

export interface ReferenceCandidate {
  doi?: string;
  title?: string;
  /** First entry is the first author: "Family, Given", "Given Family" or a CSL name. */
  authors?: (string | CslName)[];
  year?: number | string;
  container?: string;
}

/** `null` means the check could not be made (field missing on either side). */
export interface VerificationChecks {
  doiResolves: boolean | null;
  titleSimilarity: number | null;
  yearMatch: boolean | null;
  firstAuthorMatch: boolean | null;
  containerMatch: boolean | null;
}

export interface VerificationResult {
  status: VerificationStatus;
  matchedRecord?: ScholarlyRecord;
  provider?: ProviderId;
  checks: VerificationChecks;
  reasons: VerificationReason[];
}

export interface VerificationDeps {
  crossref: Pick<CrossrefClient, 'getWork' | 'searchWorks'>;
  /** Fallback and second opinion. Without it, only Crossref is consulted. */
  openalex?: Pick<OpenAlexClient, 'getWorkByDoi' | 'searchWorks'>;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------------------
// Field comparisons

function candidateYear(year: number | string | undefined): number | undefined {
  if (year === undefined) return undefined;
  const match = /\b(\d{4})\b/u.exec(normalizeText(String(year)));
  return match === null ? undefined : Number(match[1]);
}

/** Arabic definite article is ignored in names ("الغزالي" ≡ "غزالي"). */
function nameTokens(value: string): string[] {
  return tokens(value)
    .map((token) => (token.startsWith('ال') && token.length > 3 ? token.slice(2) : token))
    .filter((token) => token.length >= 2);
}

interface NameShape {
  tokens: string[];
  /** True when the tokens are known to be the family name only. */
  family: boolean;
}

function candidateFirstAuthor(authors: ReferenceCandidate['authors']): NameShape | undefined {
  const first = authors?.[0];
  if (first === undefined) return undefined;
  if (typeof first === 'string') {
    // "Family, Given" with a Latin or Arabic comma.
    const comma = first.search(/[,،]/u);
    return comma > 0
      ? { tokens: nameTokens(first.slice(0, comma)), family: true }
      : { tokens: nameTokens(first), family: false };
  }
  if (first.family !== undefined) return { tokens: nameTokens(first.family), family: true };
  if (first.literal !== undefined) return { tokens: nameTokens(first.literal), family: false };
  return undefined;
}

function recordFirstAuthor(item: CslItem): NameShape | undefined {
  const first = item.author?.[0];
  if (first === undefined) return undefined;
  if (first.family !== undefined) return { tokens: nameTokens(first.family), family: true };
  if (first.literal !== undefined) return { tokens: nameTokens(first.literal), family: false };
  return undefined;
}

const allIn = (needles: string[], haystack: string[]): boolean =>
  needles.length > 0 && needles.every((token) => haystack.includes(token));

/**
 * First-author family match. With a known family name on one side, all of its tokens must
 * appear on the other side; with display names on both sides, the last tokens must agree.
 * Initials (single letters) are ignored.
 */
export function firstAuthorMatches(candidate: NameShape, recorded: NameShape): boolean {
  if (candidate.tokens.length === 0 || recorded.tokens.length === 0) return false;
  if (recorded.family && candidate.family) {
    return allIn(recorded.tokens, candidate.tokens) || allIn(candidate.tokens, recorded.tokens);
  }
  if (recorded.family) return allIn(recorded.tokens, candidate.tokens);
  if (candidate.family) return allIn(candidate.tokens, recorded.tokens);
  return candidate.tokens.at(-1) === recorded.tokens.at(-1);
}

const CONTAINER_STOPWORDS = new Set(['of', 'the', 'and', 'for', 'in', 'on', 'journal']);

/** "Nat. Mach. Intell." abbreviates "Nature Machine Intelligence". */
function abbreviates(short: string, full: string): boolean {
  const s = tokens(short).filter((token) => !CONTAINER_STOPWORDS.has(token));
  const f = tokens(full).filter((token) => !CONTAINER_STOPWORDS.has(token));
  return (
    s.length > 0 && s.length === f.length && s.every((token, i) => f[i]?.startsWith(token) === true)
  );
}

export function containerMatches(candidate: string, recorded: string): boolean {
  return (
    normalizeText(candidate) === normalizeText(recorded) ||
    tokenJaccard(candidate, recorded) >= CONTAINER_JACCARD_THRESHOLD ||
    levenshteinRatio(candidate, recorded) >= CONTAINER_LEVENSHTEIN_THRESHOLD ||
    abbreviates(candidate, recorded) ||
    abbreviates(recorded, candidate)
  );
}

/** Compares a candidate with one record. Missing data on either side yields `null`. */
export function compareWithRecord(
  candidate: ReferenceCandidate,
  item: CslItem,
): Omit<VerificationChecks, 'doiResolves'> {
  const title = candidate.title?.trim();
  const year = candidateYear(candidate.year);
  const recordYear = issuedYear(item);
  const author = candidateFirstAuthor(candidate.authors);
  const recordAuthor = recordFirstAuthor(item);
  const container = candidate.container?.trim();
  const recordContainer = item['container-title'];
  return {
    titleSimilarity:
      title === undefined || title === '' || item.title === undefined
        ? null
        : titleSimilarity(title, item.title),
    yearMatch:
      year === undefined || recordYear === undefined
        ? null
        : Math.abs(year - recordYear) <= YEAR_TOLERANCE,
    firstAuthorMatch:
      author === undefined || recordAuthor === undefined
        ? null
        : firstAuthorMatches(author, recordAuthor),
    containerMatch:
      container === undefined || container === '' || recordContainer === undefined
        ? null
        : containerMatches(container, recordContainer),
  };
}

// ---------------------------------------------------------------------------------------
// Provider calls

/** Failures that mean "could not ask", as opposed to a definitive answer or a caller bug. */
function isUnavailable(error: unknown): boolean {
  return (
    isScholarlyError(error) &&
    error.code !== 'SCHOLARLY_NOT_FOUND' &&
    error.code !== 'SCHOLARLY_CONFIG_MISSING' &&
    error.code !== 'SCHOLARLY_INVALID_INPUT'
  );
}

type DoiLookup =
  | { kind: 'found'; record: ScholarlyRecord; provider: ProviderId }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

async function lookupDoi(doi: string, deps: VerificationDeps): Promise<DoiLookup> {
  const options = deps.signal === undefined ? {} : { signal: deps.signal };
  let crossrefAnswered = false;
  try {
    return {
      kind: 'found',
      record: await deps.crossref.getWork(doi, options),
      provider: 'crossref',
    };
  } catch (error) {
    if (isScholarlyError(error, 'SCHOLARLY_NOT_FOUND')) crossrefAnswered = true;
    else if (!isUnavailable(error)) throw error;
  }
  if (deps.openalex === undefined)
    return crossrefAnswered ? { kind: 'not_found' } : { kind: 'unavailable' };
  try {
    return {
      kind: 'found',
      record: await deps.openalex.getWorkByDoi(doi, options),
      provider: 'openalex',
    };
  } catch (error) {
    if (isScholarlyError(error, 'SCHOLARLY_NOT_FOUND')) {
      // Both registries' views must agree before calling a DOI non-existent.
      return crossrefAnswered ? { kind: 'not_found' } : { kind: 'unavailable' };
    }
    if (isUnavailable(error)) return { kind: 'unavailable' };
    throw error;
  }
}

interface Scored {
  record: ScholarlyRecord;
  provider: ProviderId;
  checks: Omit<VerificationChecks, 'doiResolves'>;
  accepted: boolean;
}

function score(
  candidate: ReferenceCandidate,
  provider: ProviderId,
  result: SearchResult,
): Scored[] {
  return result.records.map((record) => {
    const checks = compareWithRecord(candidate, record.item);
    const accepted =
      checks.titleSimilarity !== null &&
      checks.titleSimilarity >= TITLE_SIMILARITY_THRESHOLD &&
      checks.yearMatch === true &&
      checks.firstAuthorMatch === true;
    return { record, provider, checks, accepted };
  });
}

/** Query string sent to Crossref `query.bibliographic`: title, first-author tokens, year. */
export function bibliographicQuery(candidate: ReferenceCandidate): string {
  const author = candidateFirstAuthor(candidate.authors);
  const year = candidateYear(candidate.year);
  return [
    candidate.title?.trim() ?? '',
    author?.tokens.join(' ') ?? '',
    year === undefined ? '' : String(year),
  ]
    .filter((part) => part !== '')
    .join(' ')
    .slice(0, 480);
}

interface SearchOutcome {
  hits: Scored[];
  unavailable: boolean;
}

async function searchByTitle(
  candidate: ReferenceCandidate,
  deps: VerificationDeps,
): Promise<SearchOutcome> {
  const options = deps.signal === undefined ? {} : { signal: deps.signal };
  const hits: Scored[] = [];
  let unavailable = false;
  try {
    const result = await deps.crossref.searchWorks(bibliographicQuery(candidate), {
      ...options,
      rows: SEARCH_ROWS,
    });
    hits.push(...score(candidate, 'crossref', result));
  } catch (error) {
    if (!isUnavailable(error)) throw error;
    unavailable = true;
  }
  if (hits.some((hit) => hit.accepted) || deps.openalex === undefined) return { hits, unavailable };
  try {
    const result = await deps.openalex.searchWorks((candidate.title ?? '').trim().slice(0, 480), {
      ...options,
      perPage: SEARCH_ROWS,
    });
    hits.push(...score(candidate, 'openalex', result));
  } catch (error) {
    if (!isUnavailable(error)) throw error;
    unavailable = true;
  }
  return { hits, unavailable };
}

function best(hits: Scored[]): Scored | undefined {
  return [...hits].sort((a, b) => {
    if (a.accepted !== b.accepted) return a.accepted ? -1 : 1;
    return (b.checks.titleSimilarity ?? 0) - (a.checks.titleSimilarity ?? 0);
  })[0];
}

const EMPTY_CHECKS: VerificationChecks = {
  doiResolves: null,
  titleSimilarity: null,
  yearMatch: null,
  firstAuthorMatch: null,
  containerMatch: null,
};

function mismatchReasons(checks: Omit<VerificationChecks, 'doiResolves'>): VerificationReason[] {
  const reasons: VerificationReason[] = [];
  if (checks.titleSimilarity !== null) {
    reasons.push(
      checks.titleSimilarity >= TITLE_SIMILARITY_THRESHOLD ? 'TITLE_MATCH' : 'TITLE_MISMATCH',
    );
  }
  if (checks.yearMatch === false) reasons.push('YEAR_MISMATCH');
  if (checks.firstAuthorMatch === false) reasons.push('FIRST_AUTHOR_MISMATCH');
  if (checks.containerMatch === false) reasons.push('CONTAINER_MISMATCH');
  return reasons;
}

/** Title-search decision (no usable DOI). `prefix` carries reasons from a failed DOI lookup. */
function decideFromSearch(
  candidate: ReferenceCandidate,
  outcome: SearchOutcome,
  prefix: VerificationReason[],
  doiResolves: boolean | null,
): VerificationResult {
  const top = best(outcome.hits);
  const titleHit =
    top !== undefined &&
    top.checks.titleSimilarity !== null &&
    top.checks.titleSimilarity >= TITLE_SIMILARITY_THRESHOLD;

  if (top !== undefined && titleHit) {
    const checks = { doiResolves, ...top.checks };
    const reasons = [...prefix, ...mismatchReasons(top.checks)];
    const base = { matchedRecord: top.record, provider: top.provider, checks };
    // A work with this title exists, but the DOI the reference gives is registered nowhere:
    // the reference as written is wrong whatever the other fields say.
    if (doiResolves === false) {
      return { status: 'mismatch', ...base, reasons: [...reasons, 'TITLE_FOUND_WITH_OTHER_DOI'] };
    }
    if (top.accepted) {
      return { status: 'verified', ...base, reasons: [...reasons, 'SEARCH_MATCH'] };
    }
    const comparable = top.checks.yearMatch !== null && top.checks.firstAuthorMatch !== null;
    const contradicted = top.checks.yearMatch === false || top.checks.firstAuthorMatch === false;
    if (contradicted && !outcome.unavailable) return { status: 'mismatch', ...base, reasons };
    if (!comparable && !contradicted) {
      return {
        status: 'unverifiable',
        ...base,
        reasons: [
          ...reasons,
          'INSUFFICIENT_METADATA',
          ...(outcome.unavailable ? (['PROVIDER_UNAVAILABLE'] as const) : []),
        ],
      };
    }
    return { status: 'unverifiable', ...base, reasons: [...reasons, 'PROVIDER_UNAVAILABLE'] };
  }

  const checks = { ...EMPTY_CHECKS, doiResolves };
  if (outcome.unavailable) {
    // A definitive "this DOI does not exist" stands even if the secondary search failed.
    if (doiResolves === false) {
      return { status: 'not_found', checks, reasons: [...prefix, 'PROVIDER_UNAVAILABLE'] };
    }
    return { status: 'unverifiable', checks, reasons: [...prefix, 'PROVIDER_UNAVAILABLE'] };
  }
  return { status: 'not_found', checks, reasons: [...prefix, 'NO_MATCHING_RECORD'] };
}

/**
 * Checks a reference against Crossref and OpenAlex.
 *
 * - With a DOI: Crossref lookup (OpenAlex as fallback). A resolving DOI is `verified` unless a
 *   supplied title, year or first author contradicts the record (`mismatch`). A DOI unknown to
 *   both is `not_found`; if a title was given, a title search then checks whether the work
 *   exists under another DOI (`mismatch`).
 * - Without a DOI: Crossref bibliographic search, then OpenAlex search. A hit is accepted only
 *   when title similarity ≥ TITLE_SIMILARITY_THRESHOLD AND year within ±YEAR_TOLERANCE AND the
 *   first-author family name matches.
 * - Provider failures (network, timeout, rate limit, 5xx, unexpected payload) give
 *   `unverifiable`: never `verified`, and never `not_found` unless both registries have
 *   definitively answered 404 for the DOI.
 *
 * Throws SCHOLARLY_INVALID_INPUT when neither a DOI nor a title is given, and propagates
 * SCHOLARLY_CONFIG_MISSING (misconfiguration must be loud, not "unverifiable").
 */
export async function verifyReference(
  candidate: ReferenceCandidate,
  deps: VerificationDeps,
): Promise<VerificationResult> {
  const rawDoi = candidate.doi?.trim() ?? '';
  const title = candidate.title?.trim() ?? '';
  if (rawDoi === '' && title === '') throw new ScholarlyError('SCHOLARLY_INVALID_INPUT');

  const prefix: VerificationReason[] = [];
  const doi = rawDoi === '' ? undefined : normalizeDoi(rawDoi);
  if (rawDoi !== '' && doi === undefined) prefix.push('DOI_MALFORMED');

  if (doi !== undefined) {
    const lookup = await lookupDoi(doi, deps);
    if (lookup.kind === 'unavailable') {
      return { status: 'unverifiable', checks: EMPTY_CHECKS, reasons: ['PROVIDER_UNAVAILABLE'] };
    }
    if (lookup.kind === 'found') {
      const compared = compareWithRecord(candidate, lookup.record.item);
      const checks: VerificationChecks = { doiResolves: true, ...compared };
      const reasons: VerificationReason[] = ['DOI_RESOLVED', ...mismatchReasons(compared)];
      const contradicted =
        (compared.titleSimilarity !== null &&
          compared.titleSimilarity < TITLE_SIMILARITY_THRESHOLD) ||
        compared.yearMatch === false ||
        compared.firstAuthorMatch === false;
      if (
        compared.titleSimilarity === null &&
        compared.yearMatch === null &&
        compared.firstAuthorMatch === null
      ) {
        reasons.push('METADATA_NOT_CHECKED');
      }
      return {
        status: contradicted ? 'mismatch' : 'verified',
        matchedRecord: lookup.record,
        provider: lookup.provider,
        checks,
        reasons,
      };
    }
    prefix.push('DOI_NOT_FOUND');
    if (title === '') {
      return {
        status: 'not_found',
        checks: { ...EMPTY_CHECKS, doiResolves: false },
        reasons: prefix,
      };
    }
    return decideFromSearch(candidate, await searchByTitle(candidate, deps), prefix, false);
  }

  if (title === '') {
    // Only a malformed DOI was given.
    return { status: 'not_found', checks: EMPTY_CHECKS, reasons: prefix };
  }
  return decideFromSearch(candidate, await searchByTitle(candidate, deps), prefix, null);
}
