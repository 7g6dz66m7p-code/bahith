import { z } from 'zod';

import { ScholarlyError } from '../errors';
import type { HttpResponse } from '../http/client';
import type { CslName, CslType, ScholarlyRecord, SearchResult } from '../types';
import { cslDate, cslItem, cslName, names, record } from '../util/csl';
import { normalizeDoi, normalizePmid } from '../util/ids';
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

const BASE_URL = 'https://eutils.ncbi.nlm.nih.gov';
const PROVIDER = 'pubmed';

const esearchSchema = z.object({
  esearchresult: z.object({
    count: z.string().regex(/^\d+$/u),
    idlist: z.array(z.string().regex(/^\d+$/u)),
  }),
});

export const pubmedSummarySchema = z.object({
  uid: z.string(),
  error: optString,
  pubdate: optString,
  sortpubdate: optString,
  source: optString,
  fulljournalname: optString,
  authors: z.array(z.object({ name: optString, authtype: optString })).nullish(),
  title: optString,
  volume: optString,
  issue: optString,
  pages: optString,
  lang: z.array(z.string()).nullish(),
  issn: optString,
  essn: optString,
  pubtype: z.array(z.string()).nullish(),
  doctype: optString,
  articleids: z.array(z.object({ idtype: z.string(), value: z.string() })).nullish(),
});

export type PubmedSummary = z.infer<typeof pubmedSummarySchema>;

const esummarySchema = z.object({
  result: z.object({ uids: z.array(z.string()) }).catchall(z.unknown()),
});

/** ISO 639-2 (as used by PubMed) → BCP 47 primary tags for the common cases. */
const LANGUAGES: Record<string, string> = {
  eng: 'en',
  ara: 'ar',
  fre: 'fr',
  ger: 'de',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  rus: 'ru',
  chi: 'zh',
  jpn: 'ja',
  per: 'fa',
  tur: 'tr',
  urd: 'ur',
};

/** "LeCun Y" → { family: "LeCun", given: "Y" }; anything else stays a literal. */
export function pubmedAuthor(
  name: string | null | undefined,
  authtype: string | null | undefined,
): CslName | undefined {
  const text = cleanText(name);
  if (text === undefined) return undefined;
  if (authtype !== null && authtype !== undefined && authtype !== 'Author') {
    return cslName({ literal: text });
  }
  const match = /^(.+?)\s+([A-Z]{1,4})$/u.exec(text);
  if (match === null) return cslName({ literal: text });
  return cslName({ family: match[1], given: match[2] });
}

function pubmedDate(summary: PubmedSummary) {
  const sort = /^(\d{4})\/(\d{2})\/(\d{2})/u.exec(summary.sortpubdate ?? '');
  if (sort !== null) return cslDate(Number(sort[1]), Number(sort[2]), Number(sort[3]));
  const year = /^(\d{4})/u.exec(summary.pubdate ?? '');
  return year === null ? undefined : cslDate(Number(year[1]));
}

function pubmedType(summary: PubmedSummary): CslType {
  if (summary.doctype === 'book') return 'book';
  if (summary.doctype === 'chapter') return 'chapter';
  return 'article-journal';
}

/** PubMed ends titles with a period by convention; one trailing period is removed. */
function pubmedTitle(title: string | null | undefined): string | undefined {
  const text = cleanText(title);
  return text?.replace(/(?<!\.)\.$/u, '');
}

export function normalizePubmedSummary(
  summary: PubmedSummary,
  response: HttpResponse,
): ScholarlyRecord {
  const ids = summary.articleids ?? [];
  const rawDoi = ids.find((id) => id.idtype === 'doi')?.value;
  const language = summary.lang?.[0];
  const item = cslItem({
    id: `pubmed:${summary.uid}`,
    type: pubmedType(summary),
    title: pubmedTitle(summary.title),
    author: names(
      (summary.authors ?? []).map((author) => pubmedAuthor(author.name, author.authtype)),
    ),
    issued: pubmedDate(summary),
    'container-title': cleanText(summary.fulljournalname) ?? cleanText(summary.source),
    volume: cleanText(summary.volume),
    issue: cleanText(summary.issue),
    page: cleanText(summary.pages),
    DOI: rawDoi === undefined ? undefined : normalizeDoi(rawDoi),
    ISSN: cleanText(summary.issn) ?? cleanText(summary.essn),
    URL: `https://pubmed.ncbi.nlm.nih.gov/${summary.uid}/`,
    language: language === undefined ? undefined : (LANGUAGES[language] ?? language),
  });
  return record(PROVIDER, summary.uid, item, response);
}

/** NCBI E-utilities client for PubMed (JSON esearch/esummary). */
export class PubmedClient {
  constructor(private readonly ctx: ProviderContext) {}

  private url(tool: 'esearch' | 'esummary', params: Record<string, string>): URL {
    const url = new URL(`/entrez/eutils/${tool}.fcgi`, BASE_URL);
    url.searchParams.set('db', 'pubmed');
    url.searchParams.set('retmode', 'json');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('tool', this.ctx.config.appName);
    if (this.ctx.config.contactEmail !== undefined) {
      url.searchParams.set('email', this.ctx.config.contactEmail);
    }
    if (this.ctx.config.ncbiApiKey !== undefined) {
      url.searchParams.set('api_key', this.ctx.config.ncbiApiKey);
    }
    return url;
  }

  /** PubMed search; returns the hit count and the first `retmax` PMIDs. */
  async esearch(
    term: string,
    options: CallOptions & { retmax?: number } = {},
  ): Promise<{ count: number; ids: string[] }> {
    const text = requireQuery(PROVIDER, term);
    const retmax = requireLimit(PROVIDER, options.retmax, 5, 100);
    const { data } = await this.ctx.http.getJson(
      {
        provider: PROVIDER,
        url: this.url('esearch', { term: text, retmax: String(retmax) }),
        headers: baseHeaders(this.ctx.config),
        cacheTtlMs: CACHE_TTL.search,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      esearchSchema,
    );
    return { count: Number(data.esearchresult.count), ids: data.esearchresult.idlist };
  }

  /**
   * Document summaries for the given PMIDs, in request order. PMIDs that NCBI reports as
   * errors (unknown ids) are omitted.
   */
  async esummary(pmids: string[], options: CallOptions = {}): Promise<ScholarlyRecord[]> {
    const ids = pmids.map((pmid) => normalizePmid(pmid));
    if (ids.length === 0 || ids.length > 200 || ids.some((id) => id === undefined)) {
      throw new ScholarlyError('SCHOLARLY_INVALID_INPUT', { provider: PROVIDER });
    }
    const { data, response } = await this.ctx.http.getJson(
      {
        provider: PROVIDER,
        url: this.url('esummary', { id: ids.join(',') }),
        headers: baseHeaders(this.ctx.config),
        cacheTtlMs: CACHE_TTL.record,
        ...options,
      },
      esummarySchema,
    );
    const records: ScholarlyRecord[] = [];
    for (const uid of data.result.uids) {
      const parsed = pubmedSummarySchema.safeParse(data.result[uid]);
      if (!parsed.success) {
        throw new ScholarlyError('SCHOLARLY_PARSE_ERROR', {
          provider: PROVIDER,
          issuePaths: parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
        });
      }
      if (parsed.data.error !== undefined && parsed.data.error !== null) continue;
      records.push(normalizePubmedSummary(parsed.data, response));
    }
    return records;
  }

  async getByPmid(pmid: string, options: CallOptions = {}): Promise<ScholarlyRecord> {
    const [found] = await this.esummary([pmid], options);
    if (found === undefined)
      throw new ScholarlyError('SCHOLARLY_NOT_FOUND', { provider: PROVIDER });
    return found;
  }

  /** esearch followed by esummary for the returned PMIDs. */
  async search(
    term: string,
    options: CallOptions & { retmax?: number } = {},
  ): Promise<SearchResult> {
    const { count, ids } = await this.esearch(term, options);
    if (ids.length === 0) return { total: count, records: [] };
    const records = await this.esummary(
      ids,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    return { total: count, records };
  }
}
