import { describe, expect, it } from 'vitest';

import { loadScholarlyConfig, requireContactEmail, userAgent } from '../../src/config';
import { ScholarlyError } from '../../src/errors';
import { cacheKey, MemoryLruCache } from '../../src/http/cache';
import {
  normalizeArxivId,
  normalizeDoi,
  normalizeOrcid,
  normalizePmid,
  orcidCheckDigit,
} from '../../src/util/ids';
import {
  decodeEntities,
  levenshtein,
  levenshteinRatio,
  mainTitle,
  normalizeText,
  stripMarkup,
  titleSimilarity,
  tokenJaccard,
} from '../../src/util/text';

describe('MemoryLruCache', () => {
  it('evicts the least recently used entry and expires entries by TTL', async () => {
    let now = 0;
    const cache = new MemoryLruCache(2, () => now);
    await cache.set('a', '1', 1000);
    await cache.set('b', '2', 1000);
    expect(await cache.get('a')).toBe('1'); // a is now most recent
    await cache.set('c', '3', 1000);
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBe('1');
    now = 1000;
    expect(await cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(1);
    await cache.set('z', '0', 0); // non-positive TTL is not stored
    expect(await cache.get('z')).toBeUndefined();
    expect(() => new MemoryLruCache(0)).toThrow(RangeError);
  });

  it('hashes keys so query text never appears in a shared cache', () => {
    const key = cacheKey('crossref', 'https://api.crossref.org/works?query=private+question');
    expect(key).toMatch(/^scholarly:v1:crossref:[0-9a-f]{64}$/u);
    expect(key).not.toContain('private');
  });
});

describe('configuration', () => {
  it('reads optional variables and treats blanks as missing', () => {
    expect(loadScholarlyConfig({ SCHOLARLY_CONTACT_EMAIL: '' })).toEqual({ appName: 'BAHITH' });
    const config = loadScholarlyConfig({
      SCHOLARLY_CONTACT_EMAIL: 'bahith-dev@example.org',
      OPENALEX_API_KEY: 'xxxxxxxxxxxx',
    });
    expect(config.contactEmail).toBe('bahith-dev@example.org');
    expect(config.openAlexApiKey).toBe('xxxxxxxxxxxx');
    expect(userAgent(config)).toBe('BAHITH-scholarly/0.1 (mailto:bahith-dev@example.org)');
  });

  it('reports a malformed email by variable name only', () => {
    const error = (() => {
      try {
        loadScholarlyConfig({ SCHOLARLY_CONTACT_EMAIL: 'not-an-email-value' });
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ScholarlyError);
    expect((error as ScholarlyError).code).toBe('SCHOLARLY_CONFIG_MISSING');
    expect((error as ScholarlyError).variables).toEqual(['SCHOLARLY_CONTACT_EMAIL']);
    expect((error as ScholarlyError).message).not.toContain('not-an-email-value');
  });

  it('requireContactEmail throws CONFIG_MISSING when absent', () => {
    expect(() => requireContactEmail({ appName: 'BAHITH' }, 'crossref')).toThrow(
      expect.objectContaining({ code: 'SCHOLARLY_CONFIG_MISSING', provider: 'crossref' }),
    );
  });
});

describe('identifiers', () => {
  it('validates ORCID iDs with the ISO 7064 11,2 checksum', () => {
    // Examples from ORCID's own documentation (including an X check digit).
    expect(normalizeOrcid('0000-0002-1825-0097')).toBe('0000-0002-1825-0097');
    expect(normalizeOrcid('https://orcid.org/0000-0001-5109-3700')).toBe('0000-0001-5109-3700');
    expect(normalizeOrcid('0000-0002-1694-233x')).toBe('0000-0002-1694-233X');
    expect(normalizeOrcid('0000000218250097')).toBe('0000-0002-1825-0097');
    expect(orcidCheckDigit('000000021694233')).toBe('X');
    expect(normalizeOrcid('0000-0002-1825-0098')).toBeUndefined();
    expect(normalizeOrcid('0000-0002-1825-009')).toBeUndefined();
    expect(normalizeOrcid('abcd-0002-1825-0097')).toBeUndefined();
  });

  it('normalises DOIs, arXiv ids and PMIDs', () => {
    expect(normalizeDoi('https://doi.org/10.1038/NATURE14539')).toBe('10.1038/nature14539');
    expect(normalizeDoi('doi: 10.1038/nature14539')).toBe('10.1038/nature14539');
    expect(normalizeDoi('nature14539')).toBeUndefined();
    expect(normalizeDoi('10.12/x')).toBeUndefined();
    expect(normalizeArxivId('arXiv:1706.03762v7')).toBe('1706.03762v7');
    expect(normalizeArxivId('hep-th/9901001')).toBe('hep-th/9901001');
    expect(normalizeArxivId('0704.0001')).toBe('0704.0001'); // pre-2015 four-digit form
    expect(normalizeArxivId('1706.037')).toBeUndefined();
    expect(normalizePmid('26017442')).toBe('26017442');
    expect(normalizePmid('0123')).toBeUndefined();
  });
});

describe('text normalisation and similarity', () => {
  it('normalises Arabic orthography as documented', () => {
    expect(normalizeText('أَحْمَدُ')).toBe('احمد'); // tashkeel stripped, hamza alef unified
    expect(normalizeText('إسلام آمن ٱلكتاب')).toBe('اسلام امن الكتاب');
    expect(normalizeText('العـــربية')).toBe('العربيه'); // tatweel stripped, ة → ه
    expect(normalizeText('مستشفى')).toBe('مستشفي'); // ى → ي
    expect(normalizeText('رحمٰن')).toBe('رحمن'); // superscript alef U+0670
    expect(normalizeText('سنة ٢٠١٥ و۲۰۱۶')).toBe('سنه 2015 و2016');
    expect(normalizeText('Étude  sur—les "données"')).toBe('etude sur les donnees');
  });

  it('scores identical, reordered, subtitled and unrelated titles', () => {
    expect(titleSimilarity('Deep learning', 'Deep Learning.')).toBe(1);
    expect(titleSimilarity('التَّعَلُّمُ العميق', 'التعلم العميق')).toBe(1);
    expect(titleSimilarity('Deep learning', 'Deep learning: a review')).toBe(1);
    expect(
      titleSimilarity('Attention is all you need', 'Attention is al you need'),
    ).toBeGreaterThan(0.9);
    expect(titleSimilarity('Deep learning', 'Deep learning & convolutional networks')).toBeLessThan(
      0.85,
    );
    expect(
      titleSimilarity('Deep learning', 'Convolutional networks for biomedical image segmentation'),
    ).toBeLessThan(0.3);
    expect(tokenJaccard('a b c', 'c b a')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshteinRatio('', '')).toBe(1);
    expect(mainTitle('Title: Subtitle')).toBe('Title');
  });

  it('strips markup and decodes entities', () => {
    expect(stripMarkup('<jats:p>H<sub>2</sub>O &amp; CO<sub>2</sub></jats:p>')).toBe('H2O & CO2');
    expect(stripMarkup('Deep learning &amp; convolutional networks')).toBe(
      'Deep learning & convolutional networks',
    );
    expect(decodeEntities('&#x201C;x&#8221; &unknown;')).toBe('“x” &unknown;');
    expect(stripMarkup('a < b and c > d')).toBe('a < b and c > d');
  });
});
