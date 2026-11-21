import { describe, expect, it } from 'vitest';

import { ScholarlyError } from '../../src/errors';
import type { FetchLike } from '../../src/http/client';
import { ArxivClient, parseArxivFeed } from '../../src/providers/arxiv';
import { CrossrefClient } from '../../src/providers/crossref';
import { DoajClient, doajQuery } from '../../src/providers/doaj';
import { OpenAlexClient, reconstructAbstract } from '../../src/providers/openalex';
import { OrcidClient } from '../../src/providers/orcid';
import { PubmedClient, pubmedAuthor } from '../../src/providers/pubmed';
import { SemanticScholarClient } from '../../src/providers/semantic-scholar';
import { UnpaywallClient } from '../../src/providers/unpaywall';
import { CANDIDATES } from '../candidates';
import {
  fixture,
  fixtureFetch,
  TEST_CONFIG,
  TEST_EMAIL,
  testHttp,
  toResponse,
} from '../helpers/fixtures';

function setup(names?: string[], config = TEST_CONFIG) {
  const router = fixtureFetch(names);
  const { http } = testHttp(router.fetch);
  return { ctx: { http, config }, router };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof ScholarlyError)) throw new Error('expected ScholarlyError');
  return error.code;
}

describe('Crossref (recorded responses)', () => {
  it('normalises a work to CSL-JSON with provenance and sends the polite-pool mailto', async () => {
    const { ctx, router } = setup();
    const result = await new CrossrefClient(ctx).getWork('https://doi.org/10.1038/NATURE14539');
    expect(result.item).toMatchObject({
      id: 'crossref:10.1038/nature14539',
      type: 'article-journal',
      title: 'Deep learning',
      'container-title': 'Nature',
      volume: '521',
      issue: '7553',
      page: '436-444',
      DOI: '10.1038/nature14539',
      publisher: 'Springer Science and Business Media LLC',
      language: 'en',
      issued: { 'date-parts': [[2015, 5, 27]] },
    });
    expect(result.item.author?.slice(0, 3)).toEqual([
      { family: 'LeCun', given: 'Yann' },
      { family: 'Bengio', given: 'Yoshua' },
      { family: 'Hinton', given: 'Geoffrey' },
    ]);
    expect(result.provenance).toMatchObject({
      provider: 'crossref',
      providerId: '10.1038/nature14539',
      url: 'https://api.crossref.org/works/10.1038/nature14539',
    });
    expect(result.provenance.url).not.toContain(TEST_EMAIL);
    expect(router.requests[0]).toContain(`mailto=${encodeURIComponent(TEST_EMAIL)}`);
    expect(router.unmatched).toEqual([]);
  });

  it('maps the recorded 404 for a fabricated DOI to NOT_FOUND', async () => {
    const { ctx } = setup();
    expect(await errorCode(new CrossrefClient(ctx).getWork(CANDIDATES.fabricatedDoi.doi))).toBe(
      'SCHOLARLY_NOT_FOUND',
    );
  });

  it('decodes entities in search results', async () => {
    const { ctx, router } = setup();
    const result = await new CrossrefClient(ctx).searchWorks(CANDIDATES.realTitleOnlyQuery, {
      rows: 5,
    });
    expect(router.unmatched).toEqual([]);
    expect(result.total).toBeGreaterThan(0);
    expect(result.records.map((r) => r.item.title)).toContain(
      'Deep learning & convolutional networks',
    );
    expect(result.records.map((r) => r.item.DOI)).toContain('10.1038/nature14539');
  });

  it('refuses to call without a contact email', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = (input) => {
      calls.push(input);
      return Promise.resolve(new Response('{}'));
    };
    const { http } = testHttp(fetchImpl);
    const ctx = { http, config: { appName: 'BAHITH' } };
    expect(await errorCode(new CrossrefClient(ctx).getWork(CANDIDATES.real.doi))).toBe(
      'SCHOLARLY_CONFIG_MISSING',
    );
    expect(await errorCode(new OpenAlexClient(ctx).searchWorks('deep learning'))).toBe(
      'SCHOLARLY_CONFIG_MISSING',
    );
    expect(await errorCode(new UnpaywallClient(ctx).getOpenAccess(CANDIDATES.real.doi))).toBe(
      'SCHOLARLY_CONFIG_MISSING',
    );
    expect(calls).toEqual([]);
  });

  it('rejects invalid input before calling', async () => {
    const { ctx, router } = setup();
    const client = new CrossrefClient(ctx);
    expect(await errorCode(client.getWork('not a doi'))).toBe('SCHOLARLY_INVALID_INPUT');
    expect(await errorCode(client.searchWorks('   '))).toBe('SCHOLARLY_INVALID_INPUT');
    expect(await errorCode(client.searchWorks('x', { rows: 0 }))).toBe('SCHOLARLY_INVALID_INPUT');
    expect(router.requests).toEqual([]);
  });

  it('reports PARSE_ERROR when a 200 payload does not match the schema', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(
        toResponse({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' }),
      );
    const { http } = testHttp(fetchImpl);
    expect(
      await errorCode(
        new CrossrefClient({ http, config: TEST_CONFIG }).getWork(CANDIDATES.real.doi),
      ),
    ).toBe('SCHOLARLY_PARSE_ERROR');
  });
});

describe('OpenAlex (recorded responses)', () => {
  it('normalises a work, keeping display names as literals', async () => {
    const { ctx, router } = setup();
    const result = await new OpenAlexClient(ctx).getWorkByDoi(CANDIDATES.real.doi);
    expect(router.unmatched).toEqual([]);
    expect(result.item).toMatchObject({
      id: 'openalex:W2919115771',
      title: 'Deep learning',
      DOI: '10.1038/nature14539',
      'container-title': 'Nature',
      volume: '521',
      issue: '7553',
      page: '436-444',
      URL: 'https://doi.org/10.1038/nature14539',
      issued: { 'date-parts': [[2015, 5, 27]] },
    });
    expect(result.item.author?.[0]).toEqual({ literal: 'Yann LeCun' });
    expect(result.provenance.providerId).toBe('W2919115771');
  });

  it('maps the recorded 404 to NOT_FOUND and an empty search to no records', async () => {
    const { ctx } = setup();
    const client = new OpenAlexClient(ctx);
    expect(await errorCode(client.getWorkByDoi(CANDIDATES.fabricatedDoi.doi))).toBe(
      'SCHOLARLY_NOT_FOUND',
    );
  });

  // The recorded outcome is asserted either way: anonymous OpenAlex search is often refused
  // (429, shared per-IP daily budget), and that refusal is itself a recorded real response.
  it('handles the recorded search response (empty result or 429 rate limit)', async () => {
    const { ctx } = setup();
    const search = new OpenAlexClient(ctx).searchWorks(CANDIDATES.fabricatedTitle.title, {
      perPage: 5,
    });
    if (fixture('openalex-search-fabricated-title').status === 429) {
      expect(await errorCode(search)).toBe('SCHOLARLY_RATE_LIMITED');
    } else {
      expect(await search).toEqual({ total: 0, records: [] });
    }
  });

  it('sends the API key when configured but never stores it', async () => {
    const { ctx, router } = setup(undefined, {
      ...TEST_CONFIG,
      openAlexApiKey: 'xxxxxxxxxxxxxxxx',
    });
    const result = await new OpenAlexClient(ctx).getWorkByDoi(CANDIDATES.real.doi);
    expect(router.requests[0]).toContain('api_key=xxxxxxxxxxxxxxxx');
    expect(result.provenance.url).not.toContain('xxxxxxxx');
  });

  it('reconstructs abstracts from the inverted index', () => {
    expect(reconstructAbstract({ learning: [1, 4], Deep: [0], is: [2], representation: [3] })).toBe(
      'Deep learning is representation learning',
    );
    expect(reconstructAbstract(null)).toBeUndefined();
    expect(reconstructAbstract({})).toBeUndefined();
    expect(reconstructAbstract({ huge: [5_000_000] })).toBeUndefined();
  });
});

describe('Semantic Scholar (recorded responses)', () => {
  it('normalises a paper fetched by DOI', async () => {
    const { ctx, router } = setup();
    const result = await new SemanticScholarClient(ctx).getPaper('DOI:10.48550/arXiv.1706.03762');
    expect(router.unmatched).toEqual([]);
    expect(result.item).toMatchObject({
      id: 'semanticscholar:204e3073870fae3d05bcbc2f6a8e263d9b72e776',
      title: 'Attention is All you Need',
      DOI: '10.48550/arxiv.1706.03762',
      issued: { 'date-parts': [[2017, 6, 12]] },
    });
    expect(result.item.author?.[0]).toEqual({ literal: 'Ashish Vaswani' });
  });

  it('reports the real 404 Semantic Scholar returns for 10.1038/nature14539', async () => {
    const { ctx } = setup();
    expect(
      await errorCode(new SemanticScholarClient(ctx).getPaper(`DOI:${CANDIDATES.real.doi}`)),
    ).toBe('SCHOLARLY_NOT_FOUND');
  });

  // Like OpenAlex, the shared unauthenticated pool often answers 429; either recorded
  // outcome is asserted.
  it('handles the recorded search response (results or 429 rate limit)', async () => {
    const { ctx, router } = setup();
    const search = new SemanticScholarClient(ctx).searchPapers('attention is all you need', {
      limit: 3,
    });
    if (fixture('semanticscholar-search-attention').status === 429) {
      expect(await errorCode(search)).toBe('SCHOLARLY_RATE_LIMITED');
    } else {
      const result = await search;
      expect(result.total).toBeGreaterThan(0);
      expect(result.records[0]?.item.title).toBe('Attention is All you Need');
    }
    expect(router.unmatched).toEqual([]);
  });

  it('validates paper ids before calling', async () => {
    const { ctx, router } = setup();
    expect(await errorCode(new SemanticScholarClient(ctx).getPaper('nonsense id'))).toBe(
      'SCHOLARLY_INVALID_INPUT',
    );
    expect(router.requests).toEqual([]);
  });
});

describe('PubMed (recorded responses)', () => {
  it('runs esearch and normalises esummary records', async () => {
    const { ctx, router } = setup();
    const client = new PubmedClient(ctx);
    const search = await client.esearch('deep learning[Title] AND LeCun Y[Author]', { retmax: 5 });
    expect(search.ids).toContain('26017442');
    const record = await client.getByPmid('26017442');
    expect(router.unmatched).toEqual([]);
    expect(record.item).toMatchObject({
      id: 'pubmed:26017442',
      type: 'article-journal',
      title: 'Deep learning',
      'container-title': 'Nature',
      volume: '521',
      issue: '7553',
      page: '436-44',
      DOI: '10.1038/nature14539',
      language: 'en',
      issued: { 'date-parts': [[2015, 5, 28]] },
      URL: 'https://pubmed.ncbi.nlm.nih.gov/26017442/',
    });
    expect(record.item.author?.[0]).toEqual({ family: 'LeCun', given: 'Y' });
    expect(router.requests.every((r) => r.includes('tool=BAHITH'))).toBe(true);
  });

  it('maps an unknown PMID (reported as an error entry) to NOT_FOUND', async () => {
    const { ctx } = setup();
    expect(await errorCode(new PubmedClient(ctx).getByPmid('9999999999'))).toBe(
      'SCHOLARLY_NOT_FOUND',
    );
  });

  it('parses author names conservatively', () => {
    expect(pubmedAuthor('van der Berg JA', 'Author')).toEqual({
      family: 'van der Berg',
      given: 'JA',
    });
    expect(pubmedAuthor('WHO Collaborators', 'CollectiveName')).toEqual({
      literal: 'WHO Collaborators',
    });
    expect(pubmedAuthor('Plato', 'Author')).toEqual({ literal: 'Plato' });
  });
});

describe('arXiv (recorded responses)', () => {
  it('parses the Atom entry for an id', async () => {
    const { ctx, router } = setup();
    const result = await new ArxivClient(ctx).getById('1706.03762');
    expect(router.unmatched).toEqual([]);
    expect(result.item).toMatchObject({
      id: 'arxiv:1706.03762v7',
      type: 'article',
      title: 'Attention Is All You Need',
      'container-title': 'arXiv',
      URL: 'https://arxiv.org/abs/1706.03762v7',
      issued: { 'date-parts': [[2017, 6, 12]] },
    });
    expect(result.item.author).toHaveLength(8);
    expect(result.item.abstract).toMatch(/^The dominant sequence transduction models/u);
    expect(result.item.DOI).toBeUndefined();
  });

  it('maps an empty feed to NOT_FOUND and searches without stop-word terms', async () => {
    const { ctx, router } = setup();
    const client = new ArxivClient(ctx);
    expect(await errorCode(client.getById('2401.99999'))).toBe('SCHOLARLY_NOT_FOUND');
    const search = await client.search('attention is all you need', { maxResults: 3, field: 'ti' });
    expect(router.unmatched).toEqual([]);
    expect(search.total).toBeGreaterThan(0);
    expect(search.records.map((r) => r.item.title)).toContain('Attention Is All You Need');
  });

  it('rejects malformed XML and truncated feeds with PARSE_ERROR', () => {
    const xml = fixture('arxiv-id-1706.03762').body;
    expect(() => parseArxivFeed(xml.slice(0, xml.length / 2))).toThrow(
      expect.objectContaining({ code: 'SCHOLARLY_PARSE_ERROR' }),
    );
    expect(() => parseArxivFeed('<html><body>not a feed</body></html>')).toThrow(
      expect.objectContaining({ code: 'SCHOLARLY_PARSE_ERROR' }),
    );
  });
});

describe('DOAJ (recorded responses)', () => {
  it('normalises articles and decodes HTML entities', async () => {
    const { ctx, router } = setup();
    const result = await new DoajClient(ctx).searchArticles('deep learning', { pageSize: 3 });
    expect(router.unmatched).toEqual([]);
    expect(result.total).toBeGreaterThan(0);
    const first = result.records[0]?.item;
    expect(first).toMatchObject({
      type: 'article-journal',
      DOI: '10.1109/access.2019.2893871',
      'container-title': 'IEEE Access',
      volume: '7',
      page: '13546-13560',
      publisher: 'IEEE',
      language: 'en',
      issued: { 'date-parts': [[2019]] },
    });
    expect(first?.abstract).not.toMatch(/&#x/u);
  });

  it('neutralises query-string syntax', () => {
    expect(doajQuery('title:(deep) AND "learning"/x')).toBe('title deep learning x');
    expect(() => doajQuery('()')).toThrow(
      expect.objectContaining({ code: 'SCHOLARLY_INVALID_INPUT' }),
    );
  });
});

describe('ORCID (recorded responses)', () => {
  it('reads the public name and works of the ORCID demo record', async () => {
    const { ctx, router } = setup();
    const client = new OrcidClient(ctx);
    const person = await client.getPerson('https://orcid.org/0000-0002-1825-0097');
    expect(person).toMatchObject({
      orcid: '0000-0002-1825-0097',
      givenNames: 'Josiah',
      familyName: 'Carberry',
    });
    expect(person.otherNames).toContain('J. S. Carberry');
    const works = await client.getWorks('0000-0002-1825-0097');
    expect(router.unmatched).toEqual([]);
    expect(works.length).toBeGreaterThan(0);
    expect(works[0]?.item).toMatchObject({
      type: 'article-journal',
      title: 'A Methodology for the Emulation of Architecture',
      DOI: '10.5555/12345680',
      issued: { 'date-parts': [[2012]] },
    });
  });

  it('rejects an iD with a bad checksum before calling', async () => {
    const { ctx, router } = setup();
    expect(await errorCode(new OrcidClient(ctx).getPerson('0000-0002-1825-0098'))).toBe(
      'SCHOLARLY_INVALID_INPUT',
    );
    expect(router.requests).toEqual([]);
  });
});

describe('Unpaywall (recorded responses)', () => {
  it('reports exactly the best OA location Unpaywall returns', async () => {
    const { ctx, router } = setup();
    const result = await new UnpaywallClient(ctx).getOpenAccess(CANDIDATES.real.doi);
    expect(router.unmatched).toEqual([]);
    expect(result).toMatchObject({
      doi: '10.1038/nature14539',
      isOa: true,
      oaStatus: 'green',
      bestLocation: {
        url: 'https://hal.science/hal-04206682',
        pdfUrl: null,
        landingPageUrl: 'https://hal.science/hal-04206682',
        license: 'other-oa',
        version: 'submittedVersion',
        hostType: 'repository',
      },
    });
    expect(router.requests[0]).toContain(`email=${encodeURIComponent(TEST_EMAIL)}`);
    expect(result.provenance.url).toBe('https://api.unpaywall.org/v2/10.1038/nature14539');
  });

  it('reports no location when Unpaywall has none, and NOT_FOUND for an unknown DOI', async () => {
    const body = JSON.stringify({
      doi: '10.1/x',
      is_oa: false,
      oa_status: 'closed',
      best_oa_location: null,
    });
    const fetchImpl: FetchLike = () =>
      Promise.resolve(toResponse({ status: 200, contentType: 'application/json', body }));
    const { http } = testHttp(fetchImpl);
    const closed = await new UnpaywallClient({ http, config: TEST_CONFIG }).getOpenAccess(
      '10.1234/x',
    );
    expect(closed.bestLocation).toBeNull();
    expect(closed.isOa).toBe(false);
    const { ctx } = setup();
    expect(
      await errorCode(new UnpaywallClient(ctx).getOpenAccess(CANDIDATES.fabricatedDoi.doi)),
    ).toBe('SCHOLARLY_NOT_FOUND');
  });
});
