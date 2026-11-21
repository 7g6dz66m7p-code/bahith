import { z } from 'zod';

import { ScholarlyError } from '../errors';
import type { HttpResponse } from '../http/client';
import type { CslType, ScholarlyRecord, SearchResult } from '../types';
import { cslDate, cslDateFromIso, cslItem, cslName, names, record } from '../util/csl';
import { normalizeDoi } from '../util/ids';
import { cleanText } from '../util/text';
import {
  asString,
  baseHeaders,
  CACHE_TTL,
  type CallOptions,
  optNumber,
  optString,
  type ProviderContext,
  requireLimit,
  requireQuery,
} from './common';

const BASE_URL = 'https://api.semanticscholar.org';
const PROVIDER = 'semanticscholar';

const FIELDS = [
  'paperId',
  'title',
  'authors',
  'year',
  'venue',
  'externalIds',
  'abstract',
  'url',
  'publicationDate',
  'journal',
  'publicationTypes',
].join(',');

export const s2PaperSchema = z.object({
  paperId: z.string(),
  title: optString,
  authors: z.array(z.object({ authorId: optString, name: optString })).nullish(),
  year: optNumber,
  venue: optString,
  externalIds: z.record(z.string(), z.union([z.string(), z.number()]).nullable()).nullish(),
  abstract: optString,
  url: optString,
  publicationDate: optString,
  journal: z.object({ name: optString, volume: optString, pages: optString }).nullish(),
  publicationTypes: z.array(z.string()).nullish(),
});

export type S2Paper = z.infer<typeof s2PaperSchema>;

const searchSchema = z.object({
  total: z.number().int().nonnegative(),
  data: z.array(s2PaperSchema).nullish(),
});

const S2_TYPES: Record<string, CslType> = {
  JournalArticle: 'article-journal',
  Conference: 'paper-conference',
  Review: 'review',
  Book: 'book',
  BookSection: 'chapter',
  Dataset: 'dataset',
  Editorial: 'article-journal',
  LettersAndComments: 'article-journal',
};

function s2Type(types: string[] | null | undefined): CslType {
  for (const type of types ?? []) {
    const mapped = S2_TYPES[type];
    if (mapped !== undefined) return mapped;
  }
  return 'document';
}

export function normalizeS2Paper(paper: S2Paper, response: HttpResponse): ScholarlyRecord {
  const rawDoi = asString(paper.externalIds?.DOI);
  const doi = rawDoi === undefined ? undefined : normalizeDoi(rawDoi);
  const item = cslItem({
    id: `semanticscholar:${paper.paperId}`,
    type: s2Type(paper.publicationTypes),
    title: cleanText(paper.title),
    author: names((paper.authors ?? []).map((author) => cslName({ literal: author.name }))),
    issued: cslDateFromIso(paper.publicationDate) ?? cslDate(paper.year ?? undefined),
    'container-title': cleanText(paper.journal?.name) ?? cleanText(paper.venue),
    volume: cleanText(paper.journal?.volume),
    page: cleanText(paper.journal?.pages),
    DOI: doi,
    URL: cleanText(paper.url),
    abstract: cleanText(paper.abstract),
  });
  return record(PROVIDER, paper.paperId, item, response);
}

const ID_PATTERN = /^(?:[0-9a-f]{40}|(?:DOI|ARXIV|MAG|ACL|PMID|PMCID|CorpusId|URL):\S{1,300})$/u;

/** Canonical Semantic Scholar paper id, or undefined. DOI ids are normalised. */
export function normalizeS2Id(value: string): string | undefined {
  const id = value.trim();
  if (!ID_PATTERN.test(id)) return undefined;
  if (id.startsWith('DOI:')) {
    const doi = normalizeDoi(id.slice(4));
    return doi === undefined ? undefined : `DOI:${doi}`;
  }
  return id;
}

/** Semantic Scholar Graph API client (unauthenticated pool unless an API key is set). */
export class SemanticScholarClient {
  constructor(private readonly ctx: ProviderContext) {}

  private headers(): Record<string, string> {
    const headers = baseHeaders(this.ctx.config);
    if (this.ctx.config.semanticScholarApiKey !== undefined) {
      headers['x-api-key'] = this.ctx.config.semanticScholarApiKey;
    }
    return headers;
  }

  /** `id` is a S2 paper id or a prefixed external id such as `DOI:10.1038/nature14539`. */
  async getPaper(idInput: string, options: CallOptions = {}): Promise<ScholarlyRecord> {
    const id = normalizeS2Id(idInput);
    if (id === undefined)
      throw new ScholarlyError('SCHOLARLY_INVALID_INPUT', { provider: PROVIDER });
    const path = `/graph/v1/paper/${id.split('/').map(encodeURIComponent).join('/')}`;
    const url = new URL(path, BASE_URL);
    url.searchParams.set('fields', FIELDS);
    const { data, response } = await this.ctx.http.getJson(
      {
        provider: PROVIDER,
        url,
        headers: this.headers(),
        cacheTtlMs: CACHE_TTL.record,
        notFoundTtlMs: CACHE_TTL.notFound,
        ...options,
      },
      s2PaperSchema,
    );
    return normalizeS2Paper(data, response);
  }

  async searchPapers(
    query: string,
    options: CallOptions & { limit?: number } = {},
  ): Promise<SearchResult> {
    const text = requireQuery(PROVIDER, query);
    const limit = requireLimit(PROVIDER, options.limit, 5, 100);
    const url = new URL('/graph/v1/paper/search', BASE_URL);
    url.searchParams.set('query', text);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('fields', FIELDS);
    const { data, response } = await this.ctx.http.getJson(
      {
        provider: PROVIDER,
        url,
        headers: this.headers(),
        cacheTtlMs: CACHE_TTL.search,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      searchSchema,
    );
    return {
      total: data.total,
      records: (data.data ?? []).map((paper) => normalizeS2Paper(paper, response)),
    };
  }
}
