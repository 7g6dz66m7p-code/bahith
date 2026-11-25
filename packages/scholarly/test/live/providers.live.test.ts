/**
 * Live smoke tests: one real request per service, plus the two key verification decisions.
 * Opt-in only:  SCHOLARLY_LIVE=1 SCHOLARLY_CONTACT_EMAIL=… pnpm --filter @bahith/scholarly test:live
 * (behind an HTTPS proxy, Node 22 also needs NODE_USE_ENV_PROXY=1).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  createScholarlyClients,
  loadScholarlyConfig,
  type ScholarlyClients,
} from '../../src/index';
import { verifyReference } from '../../src/verify';
import { CANDIDATES } from '../candidates';

const live = process.env.SCHOLARLY_LIVE === '1';

describe.runIf(live)('live scholarly services', () => {
  let clients: ScholarlyClients;

  beforeAll(() => {
    const config = loadScholarlyConfig();
    if (config.contactEmail === undefined) {
      throw new Error('SCHOLARLY_CONTACT_EMAIL must be set for live tests.');
    }
    clients = createScholarlyClients(config, { timeoutMs: 20_000 });
  });

  it('Crossref: getWork(10.1038/nature14539)', async () => {
    const record = await clients.crossref.getWork(CANDIDATES.real.doi);
    expect(record.item.title).toBe('Deep learning');
    expect(record.item.author?.[0]?.family).toBe('LeCun');
  });

  it('OpenAlex: getWorkByDoi(10.1038/nature14539)', async () => {
    const record = await clients.openalex.getWorkByDoi(CANDIDATES.real.doi);
    expect(record.item.title).toBe('Deep learning');
    expect(record.provenance.providerId).toMatch(/^W\d+$/u);
  });

  it('Semantic Scholar: getPaper(DOI:10.48550/arXiv.1706.03762)', async () => {
    const record = await clients.semanticScholar.getPaper('DOI:10.48550/arXiv.1706.03762');
    expect(record.item.title).toMatch(/attention is all you need/iu);
  });

  it('PubMed: getByPmid(26017442)', async () => {
    const record = await clients.pubmed.getByPmid('26017442');
    expect(record.item.DOI).toBe('10.1038/nature14539');
  });

  it('arXiv: getById(1706.03762)', async () => {
    const record = await clients.arxiv.getById('1706.03762');
    expect(record.item.title).toBe('Attention Is All You Need');
  });

  it('DOAJ: searchArticles("deep learning")', async () => {
    const result = await clients.doaj.searchArticles('deep learning', { pageSize: 2 });
    expect(result.total).toBeGreaterThan(0);
    expect(result.records.length).toBeGreaterThan(0);
  });

  it('ORCID: getPerson(0000-0002-1825-0097)', async () => {
    const person = await clients.orcid.getPerson('0000-0002-1825-0097');
    expect(person.familyName).toBe('Carberry');
  });

  it('Unpaywall: getOpenAccess(10.1038/nature14539)', async () => {
    const result = await clients.unpaywall.getOpenAccess(CANDIDATES.real.doi);
    expect(result.doi).toBe('10.1038/nature14539');
    expect(typeof result.isOa).toBe('boolean');
  });

  it('verifyReference: real DOI → verified, fabricated DOI → not_found', async () => {
    const deps = { crossref: clients.crossref, openalex: clients.openalex };
    expect((await verifyReference(CANDIDATES.real, deps)).status).toBe('verified');
    expect((await verifyReference(CANDIDATES.fabricatedDoi, deps)).status).toBe('not_found');
  });
});

describe.skipIf(live)('live scholarly services (disabled)', () => {
  it('runs only with SCHOLARLY_LIVE=1', () => {
    expect(live).toBe(false);
  });
});
