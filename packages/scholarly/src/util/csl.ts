import type { CslDate, CslItem, CslName, CslType, ProviderId, ScholarlyRecord } from '../types';
import type { HttpResponse } from '../http/client';
import { cleanText } from './text';

type OptionalKeys = Exclude<keyof CslItem, 'id' | 'type'>;

/** Input for `cslItem`: optional fields may be explicitly undefined (from optional upstream data). */
export type CslItemInput = Pick<CslItem, 'id' | 'type'> & {
  [K in OptionalKeys]?: CslItem[K] | undefined;
};

/** Builds a CSL item, dropping undefined, blank strings and empty author lists. */
export function cslItem(input: CslItemInput): CslItem {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out as unknown as CslItem;
}

export function cslName(parts: {
  family?: string | null | undefined;
  given?: string | null | undefined;
  literal?: string | null | undefined;
}): CslName | undefined {
  const family = cleanText(parts.family);
  const given = cleanText(parts.given);
  const literal = cleanText(parts.literal);
  if (family !== undefined) {
    return given === undefined ? { family } : { family, given };
  }
  if (literal !== undefined) return { literal };
  if (given !== undefined) return { literal: given };
  return undefined;
}

export function names(list: (CslName | undefined)[]): CslName[] {
  return list.filter((name): name is CslName => name !== undefined);
}

function validPart(value: number | undefined, min: number, max: number): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

/** CSL date from numeric parts; undefined when there is no plausible year. */
export function cslDate(
  year: number | undefined,
  month?: number,
  day?: number,
): CslDate | undefined {
  const y = validPart(year, 1000, 9999);
  if (y === undefined) return undefined;
  const m = validPart(month, 1, 12);
  if (m === undefined) return { 'date-parts': [[y]] };
  const d = validPart(day, 1, 31);
  return { 'date-parts': [d === undefined ? [y, m] : [y, m, d]] };
}

/** CSL date from an ISO-like string: `2015`, `2015-05`, `2015-05-26`, `2015-05-26T…`. */
export function cslDateFromIso(value: string | null | undefined): CslDate | undefined {
  if (value === null || value === undefined) return undefined;
  const match = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/u.exec(value.trim());
  if (match === null) return undefined;
  return cslDate(
    Number(match[1]),
    match[2] === undefined ? undefined : Number(match[2]),
    match[3] === undefined ? undefined : Number(match[3]),
  );
}

export function issuedYear(item: CslItem): number | undefined {
  return item.issued?.['date-parts'][0][0];
}

export function record(
  provider: ProviderId,
  providerId: string,
  item: CslItem,
  response: Pick<HttpResponse, 'receivedAt' | 'url'>,
): ScholarlyRecord {
  return {
    item,
    provenance: {
      provider,
      providerId,
      fetchedAt: response.receivedAt.toISOString(),
      url: response.url,
    },
  };
}

/** Upstream type vocabularies (Crossref, OpenAlex, ORCID, Unpaywall genre) → CSL types. */
const TYPE_MAP: Record<string, CslType> = {
  'journal-article': 'article-journal',
  article: 'article-journal',
  review: 'review',
  'book-chapter': 'chapter',
  'book-section': 'chapter',
  'book-part': 'chapter',
  chapter: 'chapter',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'reference-book': 'book',
  'book-set': 'book',
  'book-series': 'book',
  'proceedings-article': 'paper-conference',
  'conference-paper': 'paper-conference',
  proceedings: 'book',
  'posted-content': 'article',
  preprint: 'article',
  dissertation: 'thesis',
  'dissertation-thesis': 'thesis',
  report: 'report',
  'report-component': 'report',
  dataset: 'dataset',
  'data-set': 'dataset',
  'reference-entry': 'entry',
  'dictionary-entry': 'entry-dictionary',
  'encyclopedia-entry': 'entry-encyclopedia',
  standard: 'standard',
  software: 'software',
  website: 'webpage',
  'magazine-article': 'article-magazine',
  'newspaper-article': 'article-newspaper',
};

export function cslType(upstream: string | null | undefined): CslType {
  if (upstream === null || upstream === undefined) return 'document';
  return (
    TYPE_MAP[
      upstream
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/gu, '-')
    ] ?? 'document'
  );
}

/** First element of an upstream string-or-array field. */
export function firstString(value: string | string[] | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return cleanText(value);
  for (const entry of value) {
    const text = cleanText(entry);
    if (text !== undefined) return text;
  }
  return undefined;
}
