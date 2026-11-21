import { z } from 'zod';

import { requireContactEmail } from '../config';
import { ScholarlyError } from '../errors';
import type { HttpResponse } from '../http/client';
import type { ScholarlyRecord, SearchResult } from '../types';
import { cslDate, cslDateFromIso, cslItem, cslName, cslType, names, record } from '../util/csl';
import { normalizeDoi } from '../util/ids';
import { cleanText } from '../util/text';
import {
  baseHeaders,
  CACHE_TTL,
  type CallOptions,
  optNumber,
  optString,
  type ProviderContext,
  requireLimit,
  requireQuery,
} from './common';

const BASE_URL = 'https://api.openalex.org';
const PROVIDER = 'openalex';

const authorshipSchema = z.object({
  author_position: optString,
  raw_author_name: optString,
  author: z.object({ id: optString, display_name: optString, orcid: optString }).nullish(),
});

const locationSchema = z
  .object({
    landing_page_url: optString,
    source: z
      .object({
        display_name: optString,
        issn_l: optString,
        host_organization_name: optString,
      })
      .nullish(),
  })
  .nullish();

export const openAlexWorkSchema = z.object({
  id: z.string(),
  doi: optString,
  title: optString,
  display_name: optString,
  publication_year: optNumber,
  publication_date: optString,
  type: optString,
  language: optString,
  biblio: z
    .object({ volume: optString, issue: optString, first_page: optString, last_page: optString })
    .nullish(),
  primary_location: locationSchema,
  authorships: z.array(authorshipSchema).nullish(),
  abstract_inverted_index: z.record(z.string(), z.array(z.number().int().nonnegative())).nullish(),
});

export type OpenAlexWork = z.infer<typeof openAlexWorkSchema>;

const listSchema = z.object({
  meta: z.object({ count: z.number().int().nonnegative().nullish() }),
  results: z.array(openAlexWorkSchema),
});

const SELECT_FIELDS = [
  'id',
  'doi',
  'title',
  'display_name',
  'publication_year',
  'publication_date',
  'type',
  'language',
  'biblio',
  'primary_location',
  'authorships',
  'abstract_inverted_index',
].join(',');

/** Guard against absurd inverted indexes (untrusted input). */
const MAX_ABSTRACT_WORDS = 20_000;

/**
 * Rebuilds the abstract text from OpenAlex's inverted index ({ word: [positions] }).
 * Returns undefined when there is no index or it is implausibly large or sparse.
 */
export function reconstructAbstract(
  index: Record<string, number[]> | null | undefined,
): string | undefined {
  if (index === null || index === undefined) return undefined;
  const words: string[] = [];
  let count = 0;
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      if (position >= MAX_ABSTRACT_WORDS) return undefined;
      words[position] = word;
      count += 1;
    }
  }
  if (count === 0) return undefined;
  // `filter` skips the holes left by positions that no word claims.
  const text = words.filter((word) => word !== '').join(' ');
  return cleanText(text);
}

function pages(
  first: string | null | undefined,
  last: string | null | undefined,
): string | undefined {
  const start = cleanText(first);
  const end = cleanText(last);
  if (start === undefined) return undefined;
  return end === undefined || end === start ? start : `${start}-${end}`;
}

export function normalizeOpenAlexWork(work: OpenAlexWork, response: HttpResponse): ScholarlyRecord {
  const shortId = work.id.replace(/^https:\/\/openalex\.org\//u, '');
  const doi = work.doi === null || work.doi === undefined ? undefined : normalizeDoi(work.doi);
  const source = work.primary_location?.source;
  const item = cslItem({
    id: `openalex:${shortId}`,
    type: cslType(work.type),
    title: cleanText(work.title ?? work.display_name),
    // OpenAlex only exposes display names; they are kept as literals rather than split
    // into family/given by guesswork.
    author: names(
      (work.authorships ?? []).map((authorship) =>
        cslName({ literal: authorship.author?.display_name ?? authorship.raw_author_name }),
      ),
    ),
    issued: cslDateFromIso(work.publication_date) ?? cslDate(work.publication_year ?? undefined),
    'container-title': cleanText(source?.display_name),
    volume: cleanText(work.biblio?.volume),
    issue: cleanText(work.biblio?.issue),
    page: pages(work.biblio?.first_page, work.biblio?.last_page),
    DOI: doi,
    ISSN: cleanText(source?.issn_l),
    URL:
      doi === undefined
        ? cleanText(work.primary_location?.landing_page_url)
        : `https://doi.org/${doi}`,
    publisher: cleanText(source?.host_organization_name),
    language: cleanText(work.language),
    abstract: reconstructAbstract(work.abstract_inverted_index),
  });
  return record(PROVIDER, shortId, item, response);
}

/** OpenAlex works API client. Requires the contact email; uses OPENALEX_API_KEY when set. */
export class OpenAlexClient {
  constructor(private readonly ctx: ProviderContext) {}

  private url(path: string, params: Record<string, string>): URL {
    const email = requireContactEmail(this.ctx.config, PROVIDER);
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('mailto', email);
    if (this.ctx.config.openAlexApiKey !== undefined) {
      url.searchParams.set('api_key', this.ctx.config.openAlexApiKey);
    }
    return url;
  }

  async getWorkByDoi(doiInput: string, options: CallOptions = {}): Promise<ScholarlyRecord> {
    const doi = normalizeDoi(doiInput);
    if (doi === undefined)
      throw new ScholarlyError('SCHOLARLY_INVALID_INPUT', { provider: PROVIDER });
    const { data, response } = await this.ctx.http.getJson(
      {
        provider: PROVIDER,
        url: this.url(`/works/doi:${doi.split('/').map(encodeURIComponent).join('/')}`, {
          select: SELECT_FIELDS,
        }),
        headers: baseHeaders(this.ctx.config),
        cacheTtlMs: CACHE_TTL.record,
        notFoundTtlMs: CACHE_TTL.notFound,
        ...options,
      },
      openAlexWorkSchema,
    );
    return normalizeOpenAlexWork(data, response);
  }

  async searchWorks(
    query: string,
    options: CallOptions & { perPage?: number } = {},
  ): Promise<SearchResult> {
    const text = requireQuery(PROVIDER, query);
    const perPage = requireLimit(PROVIDER, options.perPage, 5, 50);
    const { data, response } = await this.ctx.http.getJson(
      {
        provider: PROVIDER,
        url: this.url('/works', { search: text, per_page: String(perPage), select: SELECT_FIELDS }),
        headers: baseHeaders(this.ctx.config),
        cacheTtlMs: CACHE_TTL.search,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      listSchema,
    );
    return {
      total: data.meta.count ?? null,
      records: data.results.map((work) => normalizeOpenAlexWork(work, response)),
    };
  }
}
