import { describe, expect, it } from 'vitest';

import {
  CitationError,
  cslItemSchema,
  MAX_INTERCHANGE_CHARS,
  parseBibtex,
  parseRis,
  toBibtex,
  toRis,
  type CslItem,
  type CslItemInput,
} from '../src/index';
import { allItems, arBook, creswell, lecun } from './fixtures';

const BIBTEX = String.raw`
@article{lecun2015,
  author  = {LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey},
  title   = {Deep learning},
  journal = {Nature},
  volume  = {521},
  number  = {7553},
  pages   = {436--444},
  year    = {2015},
  doi     = {10.1038/nature14539}
}

@book{jabri2009,
  author    = {الجابري, محمد عابد},
  title     = {نقد العقل العربي},
  publisher = {مركز دراسات الوحدة العربية},
  address   = {بيروت},
  edition   = {10},
  year      = {2009}
}

@phdthesis{shamri2021,
  author = {الشمري, نورة},
  title  = {التحول الرقمي في التعليم الجامعي},
  school = {جامعة الملك سعود},
  year   = {2021}
}
`;

const RIS = [
  'TY  - JOUR',
  'AU  - LeCun, Yann',
  'AU  - Bengio, Yoshua',
  'AU  - Hinton, Geoffrey',
  'TI  - Deep learning',
  'T2  - Nature',
  'VL  - 521',
  'IS  - 7553',
  'SP  - 436',
  'EP  - 444',
  'PY  - 2015',
  'DO  - 10.1038/nature14539',
  'ID  - lecun2015',
  'ER  - ',
  'TY  - BOOK',
  'AU  - الجابري, محمد عابد',
  'TI  - نقد العقل العربي',
  'PB  - مركز دراسات الوحدة العربية',
  'CY  - بيروت',
  'ET  - 10',
  'PY  - 2009',
  'ER  - ',
  '',
].join('\n');

/** The fields a round trip must preserve. */
function keyFields(item: CslItem) {
  return {
    type: item.type,
    title: item.title,
    author: item.author?.map((name) => ({ family: name.family, given: name.given })),
    editor: item.editor?.map((name) => ({ family: name.family, given: name.given })),
    year: item.issued?.['date-parts']?.[0]?.[0],
    'container-title': item['container-title'],
    volume: item.volume,
    issue: item.issue,
    page: item.page,
    publisher: item.publisher,
    'publisher-place': item['publisher-place'],
    edition: item.edition,
    DOI: item.DOI,
  };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CitationError);
    expect((error as CitationError).code).toBe(code);
    return error as CitationError;
  }
  throw new Error(`expected ${code}`);
}

describe('parseBibtex', () => {
  it('parses English and Arabic entries into CSL-JSON', () => {
    const items = parseBibtex(BIBTEX);
    expect(items).toEqual([
      {
        id: 'lecun2015',
        'citation-key': 'lecun2015',
        type: 'article-journal',
        title: 'Deep learning',
        author: [
          { family: 'LeCun', given: 'Yann' },
          { family: 'Bengio', given: 'Yoshua' },
          { family: 'Hinton', given: 'Geoffrey' },
        ],
        'container-title': 'Nature',
        volume: '521',
        issue: '7553',
        page: '436-444',
        issued: { 'date-parts': [[2015]] },
        DOI: '10.1038/nature14539',
      },
      {
        id: 'jabri2009',
        'citation-key': 'jabri2009',
        type: 'book',
        title: 'نقد العقل العربي',
        author: [{ family: 'الجابري', given: 'محمد عابد' }],
        publisher: 'مركز دراسات الوحدة العربية',
        'publisher-place': 'بيروت',
        edition: '10',
        issued: { 'date-parts': [[2009]] },
      },
      {
        id: 'shamri2021',
        'citation-key': 'shamri2021',
        type: 'thesis',
        genre: 'PhD thesis',
        title: 'التحول الرقمي في التعليم الجامعي',
        author: [{ family: 'الشمري', given: 'نورة' }],
        publisher: 'جامعة الملك سعود',
        issued: { 'date-parts': [[2021]] },
      },
    ]);
  });

  it('accepts a UTF-8 byte-order mark and makes repeated keys unique', () => {
    const items = parseBibtex(
      `\uFEFF@book{same, title={A}, year={2001}}\n@book{same, title={B}, year={2002}}`,
    );
    expect(items.map((item) => item.id)).toEqual(['same', 'same-2']);
  });

  it('rejects malformed BibTeX with a position but without echoing the input', () => {
    const secret = 'عنوان سري';
    const error = expectCode(
      () => parseBibtex(`@article{x,\n  title = {${secret}`),
      'CITATION_PARSE_FAILED',
    );
    expect(error.details).toEqual({ line: 2, column: expect.any(Number) as number });
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.details)).not.toContain(secret);
    expectCode(() => parseBibtex('@@@{'), 'CITATION_PARSE_FAILED');
  });

  it('distinguishes empty input, no entries and oversized input', () => {
    expectCode(() => parseBibtex(''), 'CITATION_EMPTY_INPUT');
    expectCode(() => parseBibtex('  \n\t '), 'CITATION_EMPTY_INPUT');
    expectCode(() => parseBibtex('just some prose, no entries'), 'CITATION_NO_ENTRIES');
    expectCode(
      () => parseBibtex('x'.repeat(MAX_INTERCHANGE_CHARS + 1)),
      'CITATION_INPUT_TOO_LARGE',
    );
    expectCode(() => parseBibtex(42 as unknown as string), 'CITATION_INVALID_INPUT');
  });
});

describe('parseRis', () => {
  it('parses English and Arabic records', () => {
    const items = parseRis(RIS);
    expect(items.map(keyFields)).toEqual([
      {
        ...keyFields(lecun as unknown as CslItem),
        author: lecun.author,
      },
      {
        type: 'book',
        title: 'نقد العقل العربي',
        author: [{ family: 'الجابري', given: 'محمد عابد' }],
        editor: undefined,
        year: 2009,
        'container-title': undefined,
        volume: undefined,
        issue: undefined,
        page: undefined,
        publisher: 'مركز دراسات الوحدة العربية',
        'publisher-place': 'بيروت',
        edition: '10',
        DOI: undefined,
      },
    ]);
    expect(items[0]?.id).toBe('lecun2015');
    // A record without an ID tag gets a deterministic id.
    expect(items[1]?.id).toBe('ris-2');
  });

  it('rejects empty input and text with no records', () => {
    expectCode(() => parseRis(''), 'CITATION_EMPTY_INPUT');
    expectCode(() => parseRis('@article{x, title={not ris}}'), 'CITATION_NO_ENTRIES');
    expectCode(() => parseRis('garbage\nER  -\n'), 'CITATION_NO_ENTRIES');
  });
});

describe('round trips', () => {
  const fixtures: CslItemInput[] = allItems;
  const expected = fixtures.map((item) => keyFields(cslItemSchema.parse(item)));

  it('BibTeX: parse(toBibtex(items)) keeps the key fields (English and Arabic)', () => {
    const exported = toBibtex(fixtures);
    expect(exported).toContain('author = {ابن خلدون, عبد الرحمن}');
    expect(exported).toContain('@phdthesis{ar_thesis,');
    const back = parseBibtex(exported);
    expect(back.map(keyFields)).toEqual(expected);
    expect(back.map((item) => item.id)).toEqual([
      'lecun2015',
      'creswell2018',
      'braun2012',
      'shannon1940',
      'ar_article',
      'ar_book',
      'ar_chapter',
      'ar_thesis',
    ]);
  });

  it('RIS: parse(toRis(items)) keeps the key fields and ids (English and Arabic)', () => {
    const back = parseRis(toRis(fixtures));
    expect(back.map(keyFields)).toEqual(expected);
    expect(back.map((item) => item.id)).toEqual(fixtures.map((item) => item.id));
  });

  it('BibTeX -> CSL -> BibTeX is stable', () => {
    const once = toBibtex(parseBibtex(BIBTEX));
    expect(toBibtex(parseBibtex(once))).toBe(once);
  });

  it('RIS never wraps long values', () => {
    const title = 'كلمة '.repeat(40).trim();
    const ris = toRis([{ ...creswell, title }]);
    expect(ris).toContain(`TI  - ${title}\n`);
    expect(parseRis(ris)[0]?.title).toBe(title);
  });

  it('derives safe, unique BibTeX keys', () => {
    const exported = toBibtex([
      { ...creswell, id: 'مرجع' },
      { ...creswell, id: 'ref_1' },
      { ...creswell, id: '3f2a-9c' },
    ]);
    expect(exported.match(/^@\w+\{[^,]+,/gm)).toEqual([
      '@book{ref_1,',
      '@book{ref_1_2,',
      '@book{3f2a_9c,',
    ]);
  });

  it('escapes LaTeX specials and keeps DOIs verbatim', () => {
    const item = {
      id: 'special',
      type: 'book',
      title: 'R&D in 100% of cases: $5 #1 {braces} under_score ~tilde^',
      author: [{ family: 'O_Brien', given: 'A&B' }],
      DOI: '10.1000/abc_def%20',
      issued: { 'date-parts': [[2020]] },
    } satisfies CslItemInput;
    const exported = toBibtex([item]);
    expect(exported).toContain('doi = {10.1000/abc_def%20}');
    expect(exported).toContain(String.raw`100\% of cases: \$5 \#1 \{braces\} under\_score`);
    const [back] = parseBibtex(exported);
    expect(back?.title).toBe(item.title);
    expect(back?.author).toEqual(item.author);
    expect(back?.DOI).toBe(item.DOI);
  });

  it('flattens line breaks in RIS fields', () => {
    const ris = toRis([{ ...creswell, title: 'Line one\nLine two' }]);
    expect(ris).toContain('TI  - Line one Line two\n');
  });

  it('export validates items', () => {
    expectCode(() => toBibtex([{ id: 'x' }]), 'CITATION_INVALID_INPUT');
    expectCode(() => toRis([arBook, arBook]), 'CITATION_DUPLICATE_ID');
  });
});
