import { XMLParser } from 'fast-xml-parser';
import { SyntaxValidator } from 'fast-xml-validator';
import { z } from 'zod';

import { ScholarlyError } from '../errors';
import type { HttpResponse } from '../http/client';
import type { ScholarlyRecord, SearchResult } from '../types';
import { cslDateFromIso, cslItem, cslName, names, record } from '../util/csl';
import { normalizeArxivId } from '../util/ids';
import { cleanText } from '../util/text';
import {
  baseHeaders,
  CACHE_TTL,
  type CallOptions,
  type ProviderContext,
  requireLimit,
  requireQuery,
} from './common';

const BASE_URL = 'https://export.arxiv.org';
const PROVIDER = 'arxiv';

const ARRAY_TAGS = new Set(['entry', 'author', 'link', 'category']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep every value a string: arXiv ids such as 1706.03762 must not become numbers.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const text = z
  .union([z.string(), z.object({ '#text': z.string() })])
  .transform((value) => (typeof value === 'string' ? value : value['#text']));

const entrySchema = z.object({
  id: text,
  title: text.optional(),
  summary: text.optional(),
  published: text.optional(),
  updated: text.optional(),
  author: z.array(z.object({ name: text })).optional(),
  link: z
    .array(
      z.object({
        '@_href': z.string(),
        '@_rel': z.string().optional(),
        '@_type': z.string().optional(),
        '@_title': z.string().optional(),
      }),
    )
    .optional(),
  'arxiv:journal_ref': text.optional(),
});

export type ArxivEntry = z.infer<typeof entrySchema>;

const feedSchema = z.object({
  feed: z.object({
    'opensearch:totalResults': text.optional(),
    entry: z.array(entrySchema).optional(),
  }),
});

/** Validates and parses an arXiv Atom feed. Any XML or shape problem is SCHOLARLY_PARSE_ERROR. */
export function parseArxivFeed(xml: string): z.infer<typeof feedSchema> {
  let parsed: unknown;
  try {
    // The parser is lenient (it accepts truncated or mis-nested XML), so well-formedness is
    // checked first. Validator messages quote document content and are not attached.
    SyntaxValidator.validate(xml);
    parsed = parser.parse(xml);
  } catch {
    throw new ScholarlyError('SCHOLARLY_PARSE_ERROR', { provider: PROVIDER });
  }
  const result = feedSchema.safeParse(parsed);
  if (!result.success) {
    throw new ScholarlyError('SCHOLARLY_PARSE_ERROR', {
      provider: PROVIDER,
      issuePaths: result.error.issues.map((issue) => issue.path.map(String).join('.')),
    });
  }
  return result.data;
}

/**
 * Atom entry → CSL. Recorded as a preprint (`article`, container "arXiv"). The `arxiv:doi`
 * of a later journal version is deliberately not copied into `DOI`: it identifies a
 * different version of the work.
 */
export function normalizeArxivEntry(entry: ArxivEntry, response: HttpResponse): ScholarlyRecord {
  const arxivId = entry.id.replace(/^https?:\/\/arxiv\.org\/abs\//u, '');
  const abs = entry.link?.find((link) => link['@_rel'] === 'alternate')?.['@_href'];
  const item = cslItem({
    id: `arxiv:${arxivId}`,
    type: 'article',
    title: cleanText(entry.title),
    author: names((entry.author ?? []).map((author) => cslName({ literal: author.name }))),
    issued: cslDateFromIso(entry.published),
    'container-title': 'arXiv',
    publisher: 'arXiv',
    URL: abs ?? `https://arxiv.org/abs/${arxivId}`,
    abstract: cleanText(entry.summary),
  });
  return record(PROVIDER, arxivId, item, response);
}

/**
 * English stop words. arXiv's Lucene index drops them, so a required `ti:is` term matches
 * nothing and turns the whole AND query into zero hits (observed live on 2026-11-19).
 */
const ARXIV_STOPWORDS = new Set(
  'a an and are as at be but by for from has have in into is it its no not of on or such that the their then there these they this to was were will with all you we our can'.split(
    ' ',
  ),
);

/**
 * Free text → arXiv query. Default: `field:word AND field:word` over the non-stop words,
 * with query-syntax characters dropped. `phrase: true` gives `field:"exact words"`.
 */
export function arxivQuery(
  query: string,
  field: 'all' | 'ti' | 'au' | 'abs' = 'all',
  phrase = false,
): string {
  const words = query
    .replace(/[^\p{L}\p{N}\s.-]+/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word !== '' && !/^(?:AND|OR|ANDNOT)$/u.test(word))
    .slice(0, 20);
  if (phrase && words.length > 0) return `${field}:"${words.join(' ')}"`;
  const terms = words.filter((word) => !ARXIV_STOPWORDS.has(word.toLowerCase()));
  if (terms.length === 0)
    throw new ScholarlyError('SCHOLARLY_INVALID_INPUT', { provider: PROVIDER });
  return terms.map((word) => `${field}:${word}`).join(' AND ');
}

/** arXiv Atom API client (one request every 3 s, enforced by the host policy). */
export class ArxivClient {
  constructor(private readonly ctx: ProviderContext) {}

  private async fetchFeed(url: URL, ttl: number, options: CallOptions) {
    const response = await this.ctx.http.get({
      provider: PROVIDER,
      url,
      headers: baseHeaders(this.ctx.config, 'application/atom+xml'),
      cacheTtlMs: ttl,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const feed = parseArxivFeed(response.body).feed;
    // The legacy API reports bad ids as a single entry whose id points at /api/errors.
    if (feed.entry?.some((entry) => entry.id.includes('/api/errors')) === true) {
      throw new ScholarlyError('SCHOLARLY_INVALID_INPUT', { provider: PROVIDER });
    }
    return { feed, response };
  }

  async search(
    query: string,
    options: CallOptions & {
      maxResults?: number;
      field?: 'all' | 'ti' | 'au' | 'abs';
      phrase?: boolean;
    } = {},
  ): Promise<SearchResult> {
    const searchQuery = arxivQuery(requireQuery(PROVIDER, query), options.field, options.phrase);
    const maxResults = requireLimit(PROVIDER, options.maxResults, 5, 100);
    const url = new URL('/api/query', BASE_URL);
    url.searchParams.set('search_query', searchQuery);
    url.searchParams.set('start', '0');
    url.searchParams.set('max_results', String(maxResults));
    const { feed, response } = await this.fetchFeed(url, CACHE_TTL.search, options);
    const total = Number(feed['opensearch:totalResults']);
    return {
      total: Number.isFinite(total) ? total : null,
      records: (feed.entry ?? []).map((entry) => normalizeArxivEntry(entry, response)),
    };
  }

  async getById(idInput: string, options: CallOptions = {}): Promise<ScholarlyRecord> {
    const id = normalizeArxivId(idInput);
    if (id === undefined)
      throw new ScholarlyError('SCHOLARLY_INVALID_INPUT', { provider: PROVIDER });
    const url = new URL('/api/query', BASE_URL);
    url.searchParams.set('id_list', id);
    const { feed, response } = await this.fetchFeed(url, CACHE_TTL.record, options);
    const entry = feed.entry?.[0];
    if (entry === undefined)
      throw new ScholarlyError('SCHOLARLY_NOT_FOUND', { provider: PROVIDER });
    return normalizeArxivEntry(entry, response);
  }
}
