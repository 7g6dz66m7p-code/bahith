import { z } from 'zod';

import { ScholarlyError } from '../errors';
import type { HttpResponse } from '../http/client';
import type { ScholarlyRecord, SearchResult } from '../types';
import { cslDate, cslItem, cslName, names, record } from '../util/csl';
import { normalizeDoi } from '../util/ids';
import { cleanText } from '../util/text';
import {
  baseHeaders,
  CACHE_TTL,
  type CallOptions,
  optStringOrNumber,
  optString,
  type ProviderContext,
  requireLimit,
  requireQuery,
  asString,
} from './common';

const BASE_URL = 'https://doaj.org';
const PROVIDER = 'doaj';

export const doajArticleSchema = z.object({
  id: z.string(),
  bibjson: z.object({
    title: optString,
    abstract: optString,
    year: optStringOrNumber,
    month: optStringOrNumber,
    start_page: optStringOrNumber,
    end_page: optStringOrNumber,
    author: z.array(z.object({ name: optString })).nullish(),
    identifier: z.array(z.object({ id: z.string(), type: z.string() })).nullish(),
    journal: z
      .object({
        title: optString,
        volume: optStringOrNumber,
        number: optStringOrNumber,
        publisher: optString,
        language: z.array(z.string()).nullish(),
        issns: z.array(z.string()).nullish(),
      })
      .nullish(),
    link: z.array(z.object({ type: optString, url: optString })).nullish(),
  }),
});

export type DoajArticle = z.infer<typeof doajArticleSchema>;

const searchSchema = z.object({
  total: z.number().int().nonnegative(),
  results: z.array(doajArticleSchema),
});

function toInt(value: string | number | null | undefined): number | undefined {
  const text = asString(value);
  if (text === undefined || !/^\d+$/u.test(text.trim())) return undefined;
  return Number(text);
}

export function normalizeDoajArticle(
  article: DoajArticle,
  response: HttpResponse,
): ScholarlyRecord {
  const bib = article.bibjson;
  const rawDoi = bib.identifier?.find((identifier) => identifier.type.toLowerCase() === 'doi')?.id;
  const start = cleanText(asString(bib.start_page));
  const end = cleanText(asString(bib.end_page));
  const fullText = bib.link?.find((link) => link.type === 'fulltext')?.url;
  const language = bib.journal?.language?.[0];
  const item = cslItem({
    id: `doaj:${article.id}`,
    type: 'article-journal',
    title: cleanText(bib.title),
    author: names((bib.author ?? []).map((author) => cslName({ literal: author.name }))),
    issued: cslDate(toInt(bib.year), toInt(bib.month)),
    'container-title': cleanText(bib.journal?.title),
    volume: cleanText(asString(bib.journal?.volume)),
    issue: cleanText(asString(bib.journal?.number)),
    page:
      start === undefined
        ? undefined
        : end === undefined || end === start
          ? start
          : `${start}-${end}`,
    DOI: rawDoi === undefined ? undefined : normalizeDoi(rawDoi),
    ISSN: bib.journal?.issns?.[0],
    URL: cleanText(fullText) ?? `https://doaj.org/article/${article.id}`,
    publisher: cleanText(bib.journal?.publisher),
    language: language === undefined ? undefined : language.toLowerCase(),
    abstract: cleanText(bib.abstract),
  });
  return record(PROVIDER, article.id, item, response);
}

/**
 * DOAJ uses Elasticsearch query-string syntax in the path; reserved characters are replaced
 * by spaces so user text cannot change the query structure or fail to parse.
 */
export function doajQuery(query: string): string {
  const cleaned = query
    .replace(/[+\-=&|><!(){}[\]^"~*?:\\/]+/gu, ' ')
    .replace(/\b(?:AND|OR|NOT)\b/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned === '') throw new ScholarlyError('SCHOLARLY_INVALID_INPUT', { provider: PROVIDER });
  return cleaned;
}

/** DOAJ public search API (v4) client. */
export class DoajClient {
  constructor(private readonly ctx: ProviderContext) {}

  async searchArticles(
    query: string,
    options: CallOptions & { pageSize?: number; page?: number } = {},
  ): Promise<SearchResult> {
    const text = doajQuery(requireQuery(PROVIDER, query));
    const pageSize = requireLimit(PROVIDER, options.pageSize, 5, 100);
    const page = requireLimit(PROVIDER, options.page, 1, 1000);
    const url = new URL(`/api/v4/search/articles/${encodeURIComponent(text)}`, BASE_URL);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(pageSize));
    const { data, response } = await this.ctx.http.getJson(
      {
        provider: PROVIDER,
        url,
        headers: baseHeaders(this.ctx.config),
        cacheTtlMs: CACHE_TTL.search,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      searchSchema,
    );
    return {
      total: data.total,
      records: data.results.map((article) => normalizeDoajArticle(article, response)),
    };
  }
}
