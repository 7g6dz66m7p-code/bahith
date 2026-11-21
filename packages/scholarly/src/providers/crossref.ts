import { z } from 'zod';

import { requireContactEmail } from '../config';
import { ScholarlyError } from '../errors';
import type { CslDate, ScholarlyRecord, SearchResult } from '../types';
import type { HttpResponse } from '../http/client';
import { cslDate, cslItem, cslName, cslType, firstString, names, record } from '../util/csl';
import { normalizeDoi } from '../util/ids';
import { cleanText } from '../util/text';
import {
  baseHeaders,
  CACHE_TTL,
  type CallOptions,
  optString,
  type ProviderContext,
  requireLimit,
  requireQuery,
} from './common';

const BASE_URL = 'https://api.crossref.org';
const PROVIDER = 'crossref';

const dateSchema = z
  .object({ 'date-parts': z.array(z.array(z.number().nullable())).nullish() })
  .nullish();

const authorSchema = z.object({
  given: optString,
  family: optString,
  name: optString,
  sequence: optString,
});

const stringList = z.array(z.string()).nullish();

export const crossrefWorkSchema = z.object({
  DOI: z.string(),
  type: optString,
  title: stringList,
  subtitle: stringList,
  'container-title': stringList,
  volume: optString,
  issue: optString,
  page: optString,
  issued: dateSchema,
  published: dateSchema,
  'published-print': dateSchema,
  'published-online': dateSchema,
  publisher: optString,
  language: optString,
  ISBN: stringList,
  ISSN: stringList,
  URL: optString,
  abstract: optString,
  author: z.array(authorSchema).nullish(),
});

export type CrossrefWork = z.infer<typeof crossrefWorkSchema>;

const workEnvelope = z.object({
  status: z.literal('ok'),
  'message-type': z.literal('work'),
  message: crossrefWorkSchema,
});

const listEnvelope = z.object({
  status: z.literal('ok'),
  'message-type': z.literal('work-list'),
  message: z.object({
    'total-results': z.number().int().nonnegative(),
    items: z.array(crossrefWorkSchema),
  }),
});

const SELECT_FIELDS = [
  'DOI',
  'type',
  'title',
  'subtitle',
  'container-title',
  'volume',
  'issue',
  'page',
  'issued',
  'published',
  'publisher',
  // `language` is not a valid select on /works (HTTP 400 "select-not-available").
  'ISBN',
  'ISSN',
  'URL',
  'abstract',
  'author',
].join(',');

function crossrefDate(...candidates: z.infer<typeof dateSchema>[]): CslDate | undefined {
  for (const candidate of candidates) {
    const parts = candidate?.['date-parts']?.[0];
    if (parts === undefined) continue;
    const [year, month, day] = parts;
    const date = cslDate(year ?? undefined, month ?? undefined, day ?? undefined);
    if (date !== undefined) return date;
  }
  return undefined;
}

export function normalizeCrossrefWork(work: CrossrefWork, response: HttpResponse): ScholarlyRecord {
  const doi = normalizeDoi(work.DOI) ?? work.DOI.toLowerCase();
  const title = firstString(work.title);
  const subtitle = firstString(work.subtitle);
  const item = cslItem({
    id: `crossref:${doi}`,
    type: cslType(work.type),
    title: title !== undefined && subtitle !== undefined ? `${title}: ${subtitle}` : title,
    author: names(
      (work.author ?? []).map((author) =>
        cslName({ family: author.family, given: author.given, literal: author.name }),
      ),
    ),
    issued: crossrefDate(
      work.issued,
      work.published,
      work['published-print'],
      work['published-online'],
    ),
    'container-title': firstString(work['container-title']),
    volume: cleanText(work.volume),
    issue: cleanText(work.issue),
    page: cleanText(work.page),
    DOI: doi,
    ISBN: firstString(work.ISBN),
    ISSN: firstString(work.ISSN),
    URL: cleanText(work.URL),
    publisher: cleanText(work.publisher),
    language: cleanText(work.language),
    abstract: cleanText(work.abstract),
  });
  return record(PROVIDER, doi, item, response);
}

/** Crossref REST API client (polite pool: `mailto` is mandatory here). */
export class CrossrefClient {
  constructor(private readonly ctx: ProviderContext) {}

  private url(path: string, params: Record<string, string>): URL {
    const email = requireContactEmail(this.ctx.config, PROVIDER);
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('mailto', email);
    return url;
  }

  /** Looks up one work by DOI. Throws SCHOLARLY_NOT_FOUND when Crossref has no record. */
  async getWork(doiInput: string, options: CallOptions = {}): Promise<ScholarlyRecord> {
    const doi = normalizeDoi(doiInput);
    if (doi === undefined)
      throw new ScholarlyError('SCHOLARLY_INVALID_INPUT', { provider: PROVIDER });
    const path = `/works/${doi.split('/').map(encodeURIComponent).join('/')}`;
    const { data, response } = await this.ctx.http.getJson(
      {
        provider: PROVIDER,
        url: this.url(path, {}),
        headers: baseHeaders(this.ctx.config),
        cacheTtlMs: CACHE_TTL.record,
        notFoundTtlMs: CACHE_TTL.notFound,
        ...options,
      },
      workEnvelope,
    );
    return normalizeCrossrefWork(data.message, response);
  }

  /**
   * Searches works. `bibliographic` (default true) uses `query.bibliographic`, which Crossref
   * tunes for matching citation strings (title, authors, year, container).
   */
  async searchWorks(
    query: string,
    options: CallOptions & { rows?: number; bibliographic?: boolean } = {},
  ): Promise<SearchResult> {
    const text = requireQuery(PROVIDER, query);
    const rows = requireLimit(PROVIDER, options.rows, 5, 50);
    const field = options.bibliographic === false ? 'query' : 'query.bibliographic';
    const { data, response } = await this.ctx.http.getJson(
      {
        provider: PROVIDER,
        url: this.url('/works', { [field]: text, rows: String(rows), select: SELECT_FIELDS }),
        headers: baseHeaders(this.ctx.config),
        cacheTtlMs: CACHE_TTL.search,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      listEnvelope,
    );
    return {
      total: data.message['total-results'],
      records: data.message.items.map((work) => normalizeCrossrefWork(work, response)),
    };
  }
}
