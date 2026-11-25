import { describe, expect, it } from 'vitest';

import {
  checkCitationConsistency,
  findDuplicateReferences,
  normalizeDoi,
  similarity,
  type CslItemInput,
} from '../src/index';
import { arBook, braun, creswell, lecun } from './fixtures';

describe('normalizeDoi', () => {
  it.each([
    ['10.1038/nature14539', '10.1038/nature14539'],
    ['10.1038/NATURE14539', '10.1038/nature14539'],
    ['https://doi.org/10.1038/nature14539', '10.1038/nature14539'],
    ['http://dx.doi.org/10.1038/nature14539', '10.1038/nature14539'],
    ['HTTPS://WWW.DOI.ORG/10.1038/Nature14539', '10.1038/nature14539'],
    ['doi.org/10.1037/13620-004', '10.1037/13620-004'],
    ['doi:10.1037/13620-004', '10.1037/13620-004'],
    ['DOI: 10.1037/13620-004', '10.1037/13620-004'],
    ['urn:doi:10.1037/13620-004', '10.1037/13620-004'],
    [
      '  10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0  ',
      '10.1002/(sici)1097-4571(199806)49:8<693::aid-asi4>3.0.co;2-0',
    ],
    ['https://doi.org/10.1000%2Fabc', '10.1000/abc'],
    ['10.1038/nature14539.', '10.1038/nature14539'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeDoi(raw)).toBe(expected);
  });

  it.each([
    [''],
    ['nature14539'],
    ['10.12/too-short-prefix'],
    ['10.1038/'],
    ['10.1038/has space'],
    ['11.1038/nature14539'],
    ['https://example.org/10.1038/nature14539'],
    ['https://doi.org/10.1000%E0%A4%A'],
  ])('rejects %j', (raw) => {
    expect(normalizeDoi(raw)).toBeNull();
  });

  it('rejects non-strings and huge input', () => {
    expect(normalizeDoi(42 as unknown as string)).toBeNull();
    expect(normalizeDoi(`10.1000/${'a'.repeat(3000)}`)).toBeNull();
  });
});

describe('similarity', () => {
  it('is 1 for equal strings, 0 against empty, and symmetric', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('abc', '')).toBe(0);
    expect(similarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7);
    expect(similarity('sitting', 'kitten')).toBe(similarity('kitten', 'sitting'));
  });
});

describe('findDuplicateReferences', () => {
  it('groups items with the same DOI in any notation', () => {
    const groups = findDuplicateReferences([
      lecun,
      creswell,
      {
        ...lecun,
        id: 'copy',
        title: 'Something else entirely',
        DOI: 'https://doi.org/10.1038/NATURE14539',
      },
    ]);
    expect(groups).toEqual([{ ids: ['lecun2015', 'copy'], reasons: ['doi'] }]);
  });

  it('matches by title, year and first author despite case and punctuation', () => {
    const groups = findDuplicateReferences([
      creswell,
      {
        ...creswell,
        id: 'c2',
        title: 'RESEARCH DESIGN — qualitative, quantitative & mixed methods approaches',
      },
      { ...creswell, id: 'c3', issued: { 'date-parts': [[2014]] } },
    ]);
    expect(groups).toEqual([{ ids: ['creswell2018', 'c2'], reasons: ['metadata'] }]);
  });

  it('normalises Arabic: tashkeel, tatweel, alef/hamza/ya/teh marbuta and «ال»', () => {
    const variant: CslItemInput = {
      ...arBook,
      id: 'variant',
      title: 'الْمُقَدِّمَـــة',
      author: [{ family: 'ابن خلدون', given: 'عبد الرحمن' }],
    };
    const hamza: CslItemInput = {
      id: 'h1',
      type: 'book',
      title: 'مسؤولية الإدارة في المدرسة',
      author: [{ family: 'الأنصاري', given: 'علي' }],
      issued: { 'date-parts': [[2010]] },
    };
    const hamzaVariant: CslItemInput = {
      ...hamza,
      id: 'h2',
      title: 'مسئولية الاداره فى المدرسه',
      author: [{ family: 'انصاري', given: 'علي' }],
    };
    expect(findDuplicateReferences([arBook, variant, hamza, hamzaVariant, lecun])).toEqual([
      { ids: ['ar-book', 'variant'], reasons: ['metadata'] },
      { ids: ['h1', 'h2'], reasons: ['metadata'] },
    ]);
  });

  it('never merges two different DOIs by metadata', () => {
    const preprint = { ...lecun, id: 'preprint', DOI: '10.48550/arxiv.0000.00000' };
    expect(findDuplicateReferences([lecun, preprint])).toEqual([]);
    // Without a DOI on one side, metadata still applies.
    expect(findDuplicateReferences([lecun, { ...preprint, DOI: undefined }])).toEqual([
      { ids: ['lecun2015', 'preprint'], reasons: ['metadata'] },
    ]);
  });

  it('merges transitively and reports every reason', () => {
    const a = { ...braun, id: 'a' };
    const b = { ...braun, id: 'b', DOI: undefined };
    const c = { ...braun, id: 'c', title: 'Unrelated title' };
    expect(findDuplicateReferences([a, b, c])).toEqual([
      { ids: ['a', 'b', 'c'], reasons: ['doi', 'metadata'] },
    ]);
  });

  it('honours the similarity threshold and ignores untitled items', () => {
    const near = {
      ...creswell,
      id: 'near',
      title: 'Research design: Qualitative and quantitative approaches',
    };
    expect(findDuplicateReferences([creswell, near])).toEqual([]);
    expect(findDuplicateReferences([creswell, near], { titleSimilarity: 0.6 })).toHaveLength(1);
    const untitled = { id: 'u1', type: 'book' } as const;
    expect(findDuplicateReferences([untitled, { ...untitled, id: 'u2' }])).toEqual([]);
    expect(() => findDuplicateReferences([creswell], { titleSimilarity: 2 })).toThrow(
      expect.objectContaining({ code: 'CITATION_INVALID_INPUT' }),
    );
  });
});

describe('checkCitationConsistency', () => {
  it('reports cited ids without references and unused references, once each, in order', () => {
    expect(
      checkCitationConsistency({
        citedIds: ['a', 'x', 'b', 'x', 'y'],
        bibliographyIds: ['b', 'z', 'a', 'w', 'z'],
      }),
    ).toEqual({ citedWithoutReference: ['x', 'y'], referencedButNotCited: ['z', 'w'] });
  });

  it('is clean when both sides match', () => {
    expect(checkCitationConsistency({ citedIds: ['a', 'b'], bibliographyIds: ['b', 'a'] })).toEqual(
      {
        citedWithoutReference: [],
        referencedButNotCited: [],
      },
    );
    expect(checkCitationConsistency({ citedIds: [], bibliographyIds: [] })).toEqual({
      citedWithoutReference: [],
      referencedButNotCited: [],
    });
  });

  it('validates its input', () => {
    expect(() => checkCitationConsistency({ citedIds: [''], bibliographyIds: [] })).toThrow(
      expect.objectContaining({ code: 'CITATION_INVALID_INPUT' }),
    );
    expect(() =>
      checkCitationConsistency({ citedIds: null as unknown as string[], bibliographyIds: [] }),
    ).toThrow(expect.objectContaining({ code: 'CITATION_INVALID_INPUT' }));
  });
});
