import { describe, expect, it } from 'vitest';

import {
  CitationError,
  formatBibliography,
  formatCitation,
  formatNote,
  formatNotes,
  type FormatStyle,
} from '../src/index';
import { allItems, arabicItems, braun, creswell, englishItems, lecun, shannon } from './fixtures';

/** Golden outputs, produced by the bundled CSL files (see NOTICE.md) and reviewed. */
const ENGLISH_BIBLIOGRAPHY: Record<Exclude<FormatStyle, 'arabic-traditional'>, string[]> = {
  'apa-7': [
    'Braun, V., & Clarke, V. (2012). Thematic analysis. In H. Cooper (Ed.), APA handbook of research methods in psychology (Vol. 2, pp. 57–71). American Psychological Association. https://doi.org/10.1037/13620-004',
    'Creswell, J. W., & Creswell, J. D. (2018). Research design: Qualitative, quantitative, and mixed methods approaches (5th ed.). SAGE Publications.',
    'LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539',
    'Shannon, C. E. (1940). A symbolic analysis of relay and switching circuits [Master’s thesis]. Massachusetts Institute of Technology.',
  ],
  chicago: [
    'Braun, Virginia, and Victoria Clarke. 2012. “Thematic Analysis.” In APA Handbook of Research Methods in Psychology, edited by Harris Cooper, vol. 2. American Psychological Association. https://doi.org/10.1037/13620-004.',
    'Creswell, John W., and J. David Creswell. 2018. Research Design: Qualitative, Quantitative, and Mixed Methods Approaches. 5th ed. SAGE Publications.',
    'LeCun, Yann, Yoshua Bengio, and Geoffrey Hinton. 2015. “Deep Learning.” Nature 521 (7553): 436–44. https://doi.org/10.1038/nature14539.',
    'Shannon, Claude E. 1940. “A Symbolic Analysis of Relay and Switching Circuits.” Master’s thesis, Massachusetts Institute of Technology.',
  ],
  mla: [
    'Braun, Virginia, and Victoria Clarke. “Thematic Analysis.” APA Handbook of Research Methods in Psychology, edited by Harris Cooper, vol. 2, American Psychological Association, 2012, pp. 57–71, https://doi.org/10.1037/13620-004.',
    'Creswell, John W., and J. David Creswell. Research Design: Qualitative, Quantitative, and Mixed Methods Approaches. 5th ed., SAGE Publications, 2018.',
    'LeCun, Yann, et al. “Deep Learning.” Nature, vol. 521, no. 7553, 2015, pp. 436–44, https://doi.org/10.1038/nature14539.',
    'Shannon, Claude E. A Symbolic Analysis of Relay and Switching Circuits. 1940. Massachusetts Institute of Technology, Master’s thesis.',
  ],
  'chicago-notes': [
    'Braun, Virginia, and Victoria Clarke. “Thematic Analysis.” In APA Handbook of Research Methods in Psychology, vol. 2, edited by Harris Cooper. American Psychological Association, 2012. https://doi.org/10.1037/13620-004.',
    'Creswell, John W., and J. David Creswell. Research Design: Qualitative, Quantitative, and Mixed Methods Approaches. 5th ed. SAGE Publications, 2018.',
    'LeCun, Yann, Yoshua Bengio, and Geoffrey Hinton. “Deep Learning.” Nature 521, no. 7553 (2015): 436–44. https://doi.org/10.1038/nature14539.',
    'Shannon, Claude E. “A Symbolic Analysis of Relay and Switching Circuits.” Master’s thesis, Massachusetts Institute of Technology, 1940.',
  ],
};

/**
 * Arabic items rendered with the upstream CSL `ar` locale. These pin today's behaviour,
 * including known upstream gaps (Latin comma, hyphen page ranges, «&» in APA, the
 * locale translating "editor" as «تحقيق», given names initialised per word).
 */
const ARABIC_BIBLIOGRAPHY: Record<Exclude<FormatStyle, 'arabic-traditional'>, string[]> = {
  'apa-7': [
    'ابن خلدون, ع. ا. (2004). المقدمة (ع. ا. م. الدرويش, تحقيق; 1 ط, م 1). دار يعرب.',
    'الشمري, ن. (2021). التحول الرقمي في التعليم الجامعي [رسالة دكتوراه]. جامعة الملك سعود.',
    'العتيبي, س., & الحربي, خ. (2020). أثر التعلم الإلكتروني في التحصيل الدراسي. مجلة العلوم التربوية, 12(3), 45-67. https://doi.org/10.5555/ar.2020.003',
    'المصري, ل. (2019). مناهج البحث النوعي. في أ. حسن (تحقيق), دليل الباحث في العلوم الاجتماعية (ص 101-130). دار الفكر.',
  ],
  chicago: [
    'ابن خلدون, عبد الرحمن. 2004. المقدمة. 1 ط. تحقيق عبد الله محمد الدرويش. م 1. دار يعرب.',
    'الشمري, نورة. 2021. "التحول الرقمي في التعليم الجامعي". رسالة دكتوراه, جامعة الملك سعود.',
    'العتيبي, سارة, و خالد الحربي. 2020. "أثر التعلم الإلكتروني في التحصيل الدراسي". مجلة العلوم التربوية 12 (3): 45-67. https://doi.org/10.5555/ar.2020.003.',
    'المصري, ليلى. 2019. "مناهج البحث النوعي". في دليل الباحث في العلوم الاجتماعية, تحقيق أحمد حسن. دار الفكر.',
  ],
  mla: [
    'ابن خلدون, عبد الرحمن. المقدمة. تحقيق عبد الله محمد الدرويش, 1 ط, م 1, دار يعرب, 2004.',
    'الشمري, نورة. التحول الرقمي في التعليم الجامعي. 2021. جامعة الملك سعود, رسالة دكتوراه.',
    'العتيبي, سارة, و خالد الحربي. "أثر التعلم الإلكتروني في التحصيل الدراسي". مجلة العلوم التربوية, م 12, عدد 3, 2020, ص 45-67, https://doi.org/10.5555/ar.2020.003.',
    'المصري, ليلى. "مناهج البحث النوعي". دليل الباحث في العلوم الاجتماعية, تحقيق أحمد حسن, دار الفكر, 2019, ص 101-30.',
  ],
  'chicago-notes': [
    'ابن خلدون, عبد الرحمن. المقدمة. 1 ط. م 1, تحقيق عبد الله محمد الدرويش. دار يعرب, 2004.',
    'الشمري, نورة. "التحول الرقمي في التعليم الجامعي". رسالة دكتوراه, جامعة الملك سعود, 2021.',
    'العتيبي, سارة, و خالد الحربي. "أثر التعلم الإلكتروني في التحصيل الدراسي". مجلة العلوم التربوية 12, عدد 3 (2020): 45-67. https://doi.org/10.5555/ar.2020.003.',
    'المصري, ليلى. "مناهج البحث النوعي". في دليل الباحث في العلوم الاجتماعية, تحقيق أحمد حسن. دار الفكر, 2019.',
  ],
};

const CSL_STYLES = ['apa-7', 'chicago', 'mla', 'chicago-notes'] as const;

describe('formatBibliography', () => {
  it('renders the APA 7 reference exactly as citeproc does', () => {
    const { output } = formatBibliography([lecun], {
      style: 'apa-7',
      locale: 'en',
      format: 'text',
    });
    expect(output).toBe(
      'LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539',
    );
  });

  it.each(CSL_STYLES)('%s: English article, book, chapter and thesis', (style) => {
    const result = formatBibliography(englishItems, { style, locale: 'en', format: 'text' });
    expect(result.entries.map((entry) => entry.output)).toEqual(ENGLISH_BIBLIOGRAPHY[style]);
    expect(result.entries.map((entry) => entry.id)).toEqual([
      'braun2012',
      'creswell2018',
      'lecun2015',
      'shannon1940',
    ]);
    expect(result.output).toBe(ENGLISH_BIBLIOGRAPHY[style].join('\n'));
  });

  it.each(CSL_STYLES)(
    '%s: Arabic article, book, chapter and thesis with the ar locale',
    (style) => {
      const result = formatBibliography(arabicItems, { style, locale: 'ar', format: 'text' });
      expect(result.entries.map((entry) => entry.output)).toEqual(ARABIC_BIBLIOGRAPHY[style]);
    },
  );

  it('every item appears exactly once', () => {
    for (const style of CSL_STYLES) {
      for (const locale of ['ar', 'en'] as const) {
        const ids = formatBibliography(allItems, { style, locale }).entries.map(
          (entry) => entry.id,
        );
        expect([...ids].sort()).toEqual(allItems.map((item) => item.id).sort());
      }
    }
  });

  it('renders HTML with entry ids and dir="auto"', () => {
    const { output, entries } = formatBibliography([lecun], {
      style: 'apa-7',
      locale: 'en',
      format: 'html',
    });
    expect(entries[0]?.output).toBe(
      '<div class="csl-entry" data-csl-entry-id="lecun2015" dir="auto">LeCun, Y., Bengio, Y., &#38; Hinton, G. (2015). Deep learning. <i>Nature</i>, <i>521</i>(7553), 436–444. https://doi.org/10.1038/nature14539</div>',
    );
    expect(output).toBe(`<div class="csl-bib-body">\n  ${entries[0]?.output ?? ''}\n</div>`);
  });

  it('escapes markup in item fields in HTML output', () => {
    const item = { ...creswell, title: 'Tags <script>alert(1)</script> & more' };
    const { output } = formatBibliography([item], { style: 'apa-7', locale: 'en', format: 'html' });
    expect(output).not.toContain('<script>');
    expect(output).toContain('&#60;script&#62;');
  });

  it('defaults to text and returns an empty list for no items', () => {
    expect(formatBibliography([], { style: 'mla', locale: 'en' })).toEqual({
      entries: [],
      output: '',
    });
    expect(formatBibliography([], { style: 'mla', locale: 'en', format: 'html' }).output).toBe(
      '<div class="csl-bib-body"></div>',
    );
  });

  it('adds year suffixes consistently to citations and references', () => {
    const a = { ...lecun, id: 'a', title: 'Deep learning' };
    const b = { ...lecun, id: 'b', title: 'Deeper learning', DOI: undefined };
    const items = [a, b];
    const bibliography = formatBibliography(items, { style: 'apa-7', locale: 'en' });
    expect(bibliography.entries.map((entry) => entry.output.slice(0, 48))).toEqual([
      'LeCun, Y., Bengio, Y., & Hinton, G. (2015a). Dee',
      'LeCun, Y., Bengio, Y., & Hinton, G. (2015b). Dee',
    ]);
    expect(formatCitation({ itemIds: ['b'] }, items, { style: 'apa-7', locale: 'en' })).toBe(
      '(LeCun et al., 2015b)',
    );
  });
});

describe('formatCitation', () => {
  it('renders page locators in each in-text style', () => {
    const cluster = { itemIds: ['lecun2015'], locators: [{ id: 'lecun2015', locator: '437' }] };
    expect(formatCitation(cluster, englishItems, { style: 'apa-7', locale: 'en' })).toBe(
      '(LeCun et al., 2015, p. 437)',
    );
    expect(formatCitation(cluster, englishItems, { style: 'chicago', locale: 'en' })).toBe(
      '(LeCun et al. 2015, 437)',
    );
    expect(formatCitation(cluster, englishItems, { style: 'mla', locale: 'en' })).toBe(
      '(LeCun et al. 437)',
    );
  });

  it('renders page ranges and multi-item clusters', () => {
    const cluster = {
      itemIds: ['lecun2015', 'creswell2018'],
      locators: [{ id: 'creswell2018', locator: '12-14', label: 'page' as const }],
    };
    expect(formatCitation(cluster, englishItems, { style: 'apa-7', locale: 'en' })).toBe(
      '(Creswell & Creswell, 2018, pp. 12–14; LeCun et al., 2015)',
    );
  });

  it('renders other locator labels', () => {
    const cluster = {
      itemIds: ['braun2012'],
      locators: [{ id: 'braun2012', locator: '3', label: 'chapter' as const }],
    };
    expect(formatCitation(cluster, englishItems, { style: 'apa-7', locale: 'en' })).toBe(
      '(Braun & Clarke, 2012, Chapter 3)',
    );
  });

  it('renders Arabic citations with the ar locale', () => {
    const cluster = { itemIds: ['ar-book'], locators: [{ id: 'ar-book', locator: '12-14' }] };
    expect(formatCitation(cluster, arabicItems, { style: 'apa-7', locale: 'ar' })).toBe(
      '(ابن خلدون, 2004, ص 12-14)',
    );
    expect(formatCitation(cluster, arabicItems, { style: 'chicago', locale: 'ar' })).toBe(
      '(ابن خلدون 2004, 12-14)',
    );
    expect(formatCitation(cluster, arabicItems, { style: 'mla', locale: 'ar' })).toBe(
      '(ابن خلدون 12-14)',
    );
  });

  it('renders HTML', () => {
    expect(
      formatCitation({ itemIds: ['creswell2018'] }, englishItems, {
        style: 'apa-7',
        locale: 'en',
        format: 'html',
      }),
    ).toBe('(Creswell &#38; Creswell, 2018)');
  });

  it('rejects unknown items, duplicate ids and stray locators', () => {
    const options = { style: 'apa-7', locale: 'en' } as const;
    expect(() => formatCitation({ itemIds: ['missing'] }, englishItems, options)).toThrow(
      expect.objectContaining({ code: 'CITATION_UNKNOWN_ITEM' }),
    );
    expect(() =>
      formatCitation({ itemIds: ['lecun2015', 'lecun2015'] }, englishItems, options),
    ).toThrow(expect.objectContaining({ code: 'CITATION_INVALID_INPUT' }));
    expect(() =>
      formatCitation(
        { itemIds: ['lecun2015'], locators: [{ id: 'creswell2018', locator: '1' }] },
        englishItems,
        options,
      ),
    ).toThrow(expect.objectContaining({ code: 'CITATION_INVALID_INPUT' }));
    expect(() => formatCitation({ itemIds: [] }, englishItems, options)).toThrow(
      expect.objectContaining({ code: 'CITATION_INVALID_INPUT' }),
    );
    expect(() => formatCitation({ itemIds: ['lecun2015'] }, [lecun, lecun], options)).toThrow(
      expect.objectContaining({ code: 'CITATION_DUPLICATE_ID' }),
    );
  });

  it('rejects invalid options and items with value-free errors', () => {
    const secret = 'نص بحثي سري';
    try {
      formatBibliography([{ id: 'x', type: secret }], { style: 'apa-7', locale: 'en' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CitationError);
      const citationError = error as CitationError;
      expect(citationError.code).toBe('CITATION_INVALID_INPUT');
      expect(citationError.details.issues).toEqual([
        { path: ['items', 0, 'type'], code: 'invalid_value' },
      ]);
      expect(
        JSON.stringify({ message: citationError.message, details: citationError.details }),
      ).not.toContain(secret);
    }
    expect(() =>
      formatBibliography([lecun], { style: 'harvard' as 'apa-7', locale: 'en' }),
    ).toThrow(expect.objectContaining({ code: 'CITATION_INVALID_INPUT' }));
    expect(() => formatBibliography([lecun], { style: 'apa-7', locale: 'fr' as 'en' })).toThrow(
      expect.objectContaining({ code: 'CITATION_INVALID_INPUT' }),
    );
    expect(() =>
      formatBibliography([{ ...lecun, author: [{ given: 'Only' }] }], {
        style: 'apa-7',
        locale: 'en',
      }),
    ).toThrow(expect.objectContaining({ code: 'CITATION_INVALID_INPUT' }));
  });
});

describe('formatNotes (chicago-notes)', () => {
  it('renders first, short and repeated notes in document order', () => {
    const notes = formatNotes(
      [
        { itemIds: ['lecun2015'], locators: [{ id: 'lecun2015', locator: '437' }] },
        { itemIds: ['lecun2015'], locators: [{ id: 'lecun2015', locator: '438' }] },
        { itemIds: ['creswell2018'] },
        { itemIds: ['lecun2015'] },
      ],
      englishItems,
      { style: 'chicago-notes', locale: 'en' },
    );
    expect(notes).toEqual([
      'Yann LeCun et al., “Deep Learning,” Nature 521, no. 7553 (2015): 437, https://doi.org/10.1038/nature14539.',
      'LeCun et al., “Deep Learning,” 438.',
      'John W. Creswell and J. David Creswell, Research Design: Qualitative, Quantitative, and Mixed Methods Approaches, 5th ed. (SAGE Publications, 2018).',
      'LeCun et al., “Deep Learning.”',
    ]);
  });

  it('renders first-reference notes for each item type', () => {
    const notes = formatNotes(
      [braun, shannon].map((item) => ({
        itemIds: [item.id],
        locators: [{ id: item.id, locator: '60' }],
      })),
      englishItems,
      { style: 'chicago-notes', locale: 'en' },
    );
    expect(notes).toEqual([
      'Virginia Braun and Victoria Clarke, “Thematic Analysis,” in APA Handbook of Research Methods in Psychology, vol. 2, ed. Harris Cooper (American Psychological Association, 2012), 60, https://doi.org/10.1037/13620-004.',
      'Claude E. Shannon, “A Symbolic Analysis of Relay and Switching Circuits” (Master’s thesis, Massachusetts Institute of Technology, 1940), 60.',
    ]);
  });

  it('renders Arabic notes with the ar locale', () => {
    const [note] = formatNotes(
      [{ itemIds: ['ar-article'], locators: [{ id: 'ar-article', locator: '50' }] }],
      arabicItems,
      { style: 'chicago-notes', locale: 'ar' },
    );
    expect(note).toBe(
      'سارة العتيبي و خالد الحربي, "أثر التعلم الإلكتروني في التحصيل الدراسي", مجلة العلوم التربوية 12, عدد 3 (2020): 50, https://doi.org/10.5555/ar.2020.003.',
    );
  });

  it('formatNote uses the preceding notes for short forms', () => {
    const first = { itemIds: ['lecun2015'] };
    const options = { style: 'chicago-notes', locale: 'en' } as const;
    expect(formatNote(first, englishItems, options)).toBe(
      'Yann LeCun et al., “Deep Learning,” Nature 521, no. 7553 (2015): 436–44, https://doi.org/10.1038/nature14539.',
    );
    expect(
      formatNote(
        { itemIds: ['lecun2015'], locators: [{ id: 'lecun2015', locator: '440' }] },
        englishItems,
        { ...options, precedingNotes: [first] },
      ),
    ).toBe('LeCun et al., “Deep Learning,” 440.');
  });

  it('refuses in-text styles', () => {
    expect(() =>
      formatNotes([{ itemIds: ['lecun2015'] }], englishItems, { style: 'apa-7', locale: 'en' }),
    ).toThrow(expect.objectContaining({ code: 'CITATION_NOT_NOTE_STYLE' }));
    expect(() =>
      formatNote({ itemIds: ['lecun2015'] }, englishItems, { style: 'mla', locale: 'en' }),
    ).toThrow(expect.objectContaining({ code: 'CITATION_NOT_NOTE_STYLE' }));
  });

  it('returns no notes for no clusters', () => {
    expect(formatNotes([], englishItems, { style: 'chicago-notes', locale: 'en' })).toEqual([]);
  });
});

describe('determinism', () => {
  it('returns identical output regardless of call history and input order', () => {
    const options = { style: 'apa-7', locale: 'en' } as const;
    const first = formatBibliography(englishItems, options);
    formatCitation({ itemIds: ['shannon1940'] }, [shannon], options);
    formatBibliography(arabicItems, { ...options, locale: 'ar' });
    formatNotes([{ itemIds: ['lecun2015'] }, { itemIds: ['lecun2015'] }], englishItems, {
      style: 'chicago-notes',
      locale: 'en',
    });
    const again = formatBibliography([...englishItems].reverse(), options);
    expect(again).toEqual(first);
    for (let i = 0; i < 3; i += 1) {
      expect(formatCitation({ itemIds: ['lecun2015'] }, englishItems, options)).toBe(
        '(LeCun et al., 2015)',
      );
    }
  });

  it('does not mutate the items it is given', () => {
    const items = structuredClone(englishItems);
    formatBibliography(items, { style: 'chicago', locale: 'en' });
    formatNotes([{ itemIds: ['braun2012'] }], items, { style: 'chicago-notes', locale: 'en' });
    expect(items).toEqual(englishItems);
  });

  it('uses stored item data, not data from an earlier call with the same id', () => {
    const options = { style: 'apa-7', locale: 'en' } as const;
    formatBibliography([lecun], options);
    const changed = { ...lecun, title: 'A different title' };
    expect(formatBibliography([changed], options).output).toContain('A different title');
  });
});
