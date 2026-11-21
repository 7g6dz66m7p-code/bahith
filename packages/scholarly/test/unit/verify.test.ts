import { describe, expect, it } from 'vitest';

import { ScholarlyError } from '../../src/errors';
import type { FetchLike } from '../../src/http/client';
import { CrossrefClient } from '../../src/providers/crossref';
import { OpenAlexClient } from '../../src/providers/openalex';
import type { ScholarlyRecord } from '../../src/types';
import {
  compareWithRecord,
  containerMatches,
  TITLE_SIMILARITY_THRESHOLD,
  verifyReference,
  type VerificationDeps,
} from '../../src/verify';
import { CANDIDATES } from '../candidates';
import { fixture, fixtureFetch, TEST_CONFIG, testHttp } from '../helpers/fixtures';

function recordedDeps(fetchImpl?: FetchLike) {
  const router = fixtureFetch();
  const { http } = testHttp(fetchImpl ?? router.fetch);
  const ctx = { http, config: TEST_CONFIG };
  const deps: VerificationDeps = {
    crossref: new CrossrefClient(ctx),
    openalex: new OpenAlexClient(ctx),
  };
  return { deps, router };
}

const failingFetch: FetchLike = () => Promise.reject(new TypeError('fetch failed'));

describe('verifyReference on recorded responses', () => {
  it('verifies the real DOI 10.1038/nature14539 (LeCun et al. 2015)', async () => {
    const { deps, router } = recordedDeps();
    const result = await verifyReference(CANDIDATES.real, deps);
    expect(router.unmatched).toEqual([]);
    expect(result.status).toBe('verified');
    expect(result.provider).toBe('crossref');
    expect(result.checks).toEqual({
      doiResolves: true,
      titleSimilarity: 1,
      yearMatch: true,
      firstAuthorMatch: true,
      containerMatch: true,
    });
    expect(result.reasons).toEqual(['DOI_RESOLVED', 'TITLE_MATCH']);
    expect(result.matchedRecord?.item.DOI).toBe('10.1038/nature14539');
  });

  it('flags the real DOI cited with a wrong title as a mismatch', async () => {
    const { deps, router } = recordedDeps();
    const result = await verifyReference(CANDIDATES.wrongTitle, deps);
    expect(router.unmatched).toEqual([]);
    expect(result.status).toBe('mismatch');
    expect(result.checks.doiResolves).toBe(true);
    expect(result.checks.titleSimilarity).toBeLessThan(TITLE_SIMILARITY_THRESHOLD);
    expect(result.checks.yearMatch).toBe(true);
    expect(result.checks.firstAuthorMatch).toBe(true);
    expect(result.reasons).toEqual(['DOI_RESOLVED', 'TITLE_MISMATCH']);
  });

  it('reports the fabricated DOI 10.9999/fake.2024.12345 as not_found (Crossref and OpenAlex 404)', async () => {
    const { deps, router } = recordedDeps();
    const result = await verifyReference(CANDIDATES.fabricatedDoi, deps);
    expect(router.unmatched).toEqual([]);
    expect(router.requests.map((r) => new URL(r).host)).toEqual([
      'api.crossref.org',
      'api.openalex.org',
    ]);
    expect(result).toEqual({
      status: 'not_found',
      checks: {
        doiResolves: false,
        titleSimilarity: null,
        yearMatch: null,
        firstAuthorMatch: null,
        containerMatch: null,
      },
      reasons: ['DOI_NOT_FOUND'],
    });
  });

  it('reports a fabricated Arabic title without DOI as not_found (Crossref search)', async () => {
    const router = fixtureFetch();
    const { http } = testHttp(router.fetch);
    const result = await verifyReference(CANDIDATES.fabricatedTitle, {
      crossref: new CrossrefClient({ http, config: TEST_CONFIG }),
    });
    expect(router.unmatched).toEqual([]);
    // Crossref did return Arabic deep-learning papers; none comes near the threshold.
    expect(router.requests).toHaveLength(1);
    expect(result.status).toBe('not_found');
    expect(result.reasons).toEqual(['NO_MATCHING_RECORD']);
    expect(result.matchedRecord).toBeUndefined();
  });

  it('adds the OpenAlex search for the fabricated title: not_found, or unverifiable if it was refused', async () => {
    const { deps, router } = recordedDeps();
    const result = await verifyReference(CANDIDATES.fabricatedTitle, deps);
    expect(router.unmatched).toEqual([]);
    expect(new Set(router.requests.map((r) => new URL(r).host))).toEqual(
      new Set(['api.crossref.org', 'api.openalex.org']),
    );
    if (fixture('openalex-search-fabricated-title').status === 429) {
      // Never not_found while a provider could not be asked.
      expect(result.status).toBe('unverifiable');
      expect(result.reasons).toEqual(['PROVIDER_UNAVAILABLE']);
    } else {
      expect(result.status).toBe('not_found');
      expect(result.reasons).toEqual(['NO_MATCHING_RECORD']);
    }
  });

  it('verifies a real title without DOI by bibliographic search (title + year + first author)', async () => {
    const { deps, router } = recordedDeps();
    const result = await verifyReference(CANDIDATES.realTitleOnly, deps);
    expect(router.unmatched).toEqual([]);
    expect(result.status).toBe('verified');
    expect(result.provider).toBe('crossref');
    expect(result.matchedRecord?.item.DOI).toBe('10.1038/nature14539');
    expect(result.reasons).toEqual(['TITLE_MATCH', 'SEARCH_MATCH']);
    // Crossref answered, so OpenAlex was not consulted.
    expect(router.requests).toHaveLength(1);
  });

  it('marks a DOI-only candidate verified but says the metadata was not checked', async () => {
    const { deps } = recordedDeps();
    const result = await verifyReference({ doi: CANDIDATES.real.doi }, deps);
    expect(result.status).toBe('verified');
    expect(result.reasons).toEqual(['DOI_RESOLVED', 'METADATA_NOT_CHECKED']);
  });

  it('flags a wrong year or first author on a resolving DOI', async () => {
    const { deps } = recordedDeps();
    const wrongYear = await verifyReference({ ...CANDIDATES.real, year: 2019 }, deps);
    expect(wrongYear.status).toBe('mismatch');
    expect(wrongYear.reasons).toContain('YEAR_MISMATCH');
    const wrongAuthor = await verifyReference(
      { ...CANDIDATES.real, authors: ['Smith, John'] },
      deps,
    );
    expect(wrongAuthor.status).toBe('mismatch');
    expect(wrongAuthor.reasons).toContain('FIRST_AUTHOR_MISMATCH');
    const offByOne = await verifyReference({ ...CANDIDATES.real, year: '2016' }, deps);
    expect(offByOne.status).toBe('verified');
  });

  it('treats a journal-name mismatch as a soft signal only', async () => {
    const { deps } = recordedDeps();
    const result = await verifyReference({ ...CANDIDATES.real, container: 'Science' }, deps);
    expect(result.status).toBe('verified');
    expect(result.checks.containerMatch).toBe(false);
    expect(result.reasons).toContain('CONTAINER_MISMATCH');
  });

  it('falls back to a title search when the DOI is malformed', async () => {
    const { deps } = recordedDeps();
    const result = await verifyReference({ ...CANDIDATES.realTitleOnly, doi: 'nature14539' }, deps);
    expect(result.status).toBe('verified');
    expect(result.reasons[0]).toBe('DOI_MALFORMED');
  });
});

describe('verifyReference under provider failure', () => {
  it('returns unverifiable (never verified, never not_found) when the network fails', async () => {
    const { deps } = recordedDeps(failingFetch);
    for (const candidate of [
      CANDIDATES.real,
      CANDIDATES.fabricatedDoi,
      CANDIDATES.fabricatedTitle,
    ]) {
      const result = await verifyReference(candidate, deps);
      expect(result.status).toBe('unverifiable');
      expect(result.reasons).toContain('PROVIDER_UNAVAILABLE');
    }
  });

  it('is unverifiable when Crossref says 404 but OpenAlex cannot be reached', async () => {
    const router = fixtureFetch(['crossref-work-fabricated']);
    const { http } = testHttp(router.fetch);
    const ctx = { http, config: TEST_CONFIG };
    const result = await verifyReference(CANDIDATES.fabricatedDoi, {
      crossref: new CrossrefClient(ctx),
      openalex: new OpenAlexClient(ctx),
    });
    expect(result.status).toBe('unverifiable');
  });

  it('uses OpenAlex when Crossref is down', async () => {
    const router = fixtureFetch(['openalex-work-nature14539']);
    const { http } = testHttp(router.fetch);
    const ctx = { http, config: TEST_CONFIG };
    const result = await verifyReference(CANDIDATES.real, {
      crossref: new CrossrefClient(ctx),
      openalex: new OpenAlexClient(ctx),
    });
    expect(result.status).toBe('verified');
    expect(result.provider).toBe('openalex');
    expect(result.checks.firstAuthorMatch).toBe(true); // "LeCun, Yann" vs literal "Yann LeCun"
  });

  it('propagates configuration errors and rejects empty candidates', async () => {
    const { http } = testHttp(failingFetch);
    const ctx = { http, config: { appName: 'BAHITH' } };
    const deps = { crossref: new CrossrefClient(ctx), openalex: new OpenAlexClient(ctx) };
    await expect(verifyReference(CANDIDATES.real, deps)).rejects.toMatchObject({
      code: 'SCHOLARLY_CONFIG_MISSING',
    });
    await expect(verifyReference({ authors: ['X'] }, deps)).rejects.toBeInstanceOf(ScholarlyError);
  });
});

describe('verifyReference decisions with stub providers', () => {
  const record = (item: ScholarlyRecord['item']): ScholarlyRecord => ({
    item,
    provenance: {
      provider: 'crossref',
      providerId: 'x',
      fetchedAt: '2026-11-19T00:00:00.000Z',
      url: 'https://x',
    },
  });
  const book = record({
    id: 'crossref:10.7551/mitpress/1',
    type: 'book',
    title: 'Deep Learning',
    author: [{ family: 'Goodfellow', given: 'Ian' }],
    issued: { 'date-parts': [[2016]] },
    DOI: '10.7551/mitpress/1',
  });
  const stubDeps = (
    records: ScholarlyRecord[],
    opts: { openalexFails?: boolean } = {},
  ): VerificationDeps => ({
    crossref: {
      getWork: () => Promise.reject(new ScholarlyError('SCHOLARLY_NOT_FOUND')),
      searchWorks: () => Promise.resolve({ total: records.length, records }),
    },
    openalex: {
      getWorkByDoi: () => Promise.reject(new ScholarlyError('SCHOLARLY_NOT_FOUND')),
      searchWorks: () =>
        opts.openalexFails === true
          ? Promise.reject(new ScholarlyError('SCHOLARLY_RATE_LIMITED'))
          : Promise.resolve({ total: 0, records: [] }),
    },
  });

  it('calls a same-title work by another author a mismatch when every provider answered', async () => {
    const result = await verifyReference(
      { title: 'Deep learning', authors: ['LeCun, Yann'], year: 2015 },
      stubDeps([book]),
    );
    expect(result.status).toBe('mismatch');
    expect(result.reasons).toEqual(['TITLE_MATCH', 'FIRST_AUTHOR_MISMATCH']);
  });

  it('stays unverifiable for that case when a provider failed', async () => {
    const result = await verifyReference(
      { title: 'Deep learning', authors: ['LeCun, Yann'], year: 2015 },
      stubDeps([book], { openalexFails: true }),
    );
    expect(result.status).toBe('unverifiable');
    expect(result.reasons).toContain('PROVIDER_UNAVAILABLE');
  });

  it('is unverifiable with INSUFFICIENT_METADATA when only a title is given', async () => {
    const result = await verifyReference({ title: 'Deep learning' }, stubDeps([book]));
    expect(result.status).toBe('unverifiable');
    expect(result.reasons).toEqual(['TITLE_MATCH', 'INSUFFICIENT_METADATA']);
  });

  it('calls an unregistered DOI whose title exists elsewhere a mismatch', async () => {
    const result = await verifyReference(
      { doi: '10.9999/fake.1', title: 'Deep Learning', authors: ['Goodfellow, Ian'], year: 2016 },
      stubDeps([book]),
    );
    expect(result.status).toBe('mismatch');
    expect(result.reasons).toEqual(['DOI_NOT_FOUND', 'TITLE_MATCH', 'TITLE_FOUND_WITH_OTHER_DOI']);
    expect(result.checks.doiResolves).toBe(false);
  });

  it('matches Arabic author names across orthographic variants and the definite article', () => {
    const arabic = record({
      id: 'x',
      type: 'article-journal',
      title: 'أثر التعلّم العميق في معالجة اللغة العربية',
      author: [{ family: 'الغزالي', given: 'أحمد' }],
      issued: { 'date-parts': [[2020]] },
    });
    const checks = compareWithRecord(
      {
        title: 'اثر التعلم العميق في معالجه اللغه العربيه',
        authors: ['غزالي، احمد'],
        year: '٢٠٢١',
      },
      arabic.item,
    );
    expect(checks).toEqual({
      titleSimilarity: 1,
      yearMatch: true,
      firstAuthorMatch: true,
      containerMatch: null,
    });
  });

  it('recognises journal abbreviations', () => {
    expect(containerMatches('Nat. Mach. Intell.', 'Nature Machine Intelligence')).toBe(true);
    expect(containerMatches('Nature', 'Science')).toBe(false);
  });
});
