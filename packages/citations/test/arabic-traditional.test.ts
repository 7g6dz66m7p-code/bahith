import { describe, expect, it } from 'vitest';

import { formatBibliography, formatCitation, formatNotes, type CslItemInput } from '../src/index';
import { arabicItems, arArticle, arBook, arChapter, arThesis, lecun } from './fixtures';

const options = { style: 'arabic-traditional', locale: 'ar' } as const;

describe('arabic-traditional (التوثيق التقليدي, in-house convention)', () => {
  it('renders the first-citation footnote for each item type', () => {
    const notes = formatNotes(
      [arBook, arArticle, arChapter, arThesis].map((item) => ({
        itemIds: [item.id],
        locators: [{ id: item.id, locator: '45' }],
      })),
      arabicItems,
      options,
    );
    expect(notes).toEqual([
      'عبد الرحمن ابن خلدون، المقدمة، تحقيق: عبد الله محمد الدرويش، ط1، دار يعرب، دمشق، 2004، ج1، ص45.',
      'سارة العتيبي وخالد الحربي، «أثر التعلم الإلكتروني في التحصيل الدراسي»، مجلة العلوم التربوية، مج12، ع3، 2020، ص45.',
      'ليلى المصري، «مناهج البحث النوعي»، في: دليل الباحث في العلوم الاجتماعية، تحرير: أحمد حسن، دار الفكر، عمّان، 2019، ص45.',
      'نورة الشمري، التحول الرقمي في التعليم الجامعي، رسالة دكتوراه، جامعة الملك سعود، الرياض، 2021، ص45.',
    ]);
  });

  it('uses «المرجع نفسه» for an immediate repeat and a short form later', () => {
    const notes = formatNotes(
      [
        { itemIds: ['ar-book'], locators: [{ id: 'ar-book', locator: '45' }] },
        { itemIds: ['ar-book'], locators: [{ id: 'ar-book', locator: '46' }] },
        { itemIds: ['ar-article', 'ar-thesis'] },
        { itemIds: ['ar-book'], locators: [{ id: 'ar-book', locator: '50' }] },
        { itemIds: ['ar-article'], locators: [{ id: 'ar-article', locator: '60' }] },
      ],
      arabicItems,
      options,
    );
    expect(notes).toEqual([
      'عبد الرحمن ابن خلدون، المقدمة، تحقيق: عبد الله محمد الدرويش، ط1، دار يعرب، دمشق، 2004، ج1، ص45.',
      'المرجع نفسه، ج1، ص46.',
      'سارة العتيبي وخالد الحربي، «أثر التعلم الإلكتروني في التحصيل الدراسي»، مجلة العلوم التربوية، مج12، ع3، 2020، ص45-67؛ نورة الشمري، التحول الرقمي في التعليم الجامعي، رسالة دكتوراه، جامعة الملك سعود، الرياض، 2021.',
      'ابن خلدون، المقدمة، ج1، ص50.',
      'العتيبي، «أثر التعلم الإلكتروني في التحصيل الدراسي»، ص60.',
    ]);
  });

  it('formatCitation returns a first-reference note', () => {
    expect(
      formatCitation(
        { itemIds: ['ar-book'], locators: [{ id: 'ar-book', locator: '2', label: 'volume' }] },
        arabicItems,
        options,
      ),
    ).toBe(
      'عبد الرحمن ابن خلدون، المقدمة، تحقيق: عبد الله محمد الدرويش، ط1، دار يعرب، دمشق، 2004، ج2.',
    );
  });

  it('renders the bibliography: Arabic first, sorted ignoring «ال»', () => {
    const { entries } = formatBibliography([lecun, ...arabicItems], options);
    expect(entries).toEqual([
      {
        id: 'ar-book',
        output:
          'ابن خلدون، عبد الرحمن. المقدمة. تحقيق: عبد الله محمد الدرويش، ط1، دار يعرب، دمشق، 2004.',
      },
      {
        id: 'ar-thesis',
        output:
          'الشمري، نورة. التحول الرقمي في التعليم الجامعي. رسالة دكتوراه، جامعة الملك سعود، الرياض، 2021.',
      },
      {
        id: 'ar-article',
        output:
          'العتيبي، سارة وخالد الحربي. «أثر التعلم الإلكتروني في التحصيل الدراسي». مجلة العلوم التربوية، مج12، ع3، 2020، ص45-67.',
      },
      {
        id: 'ar-chapter',
        output:
          'المصري، ليلى. «مناهج البحث النوعي». في: دليل الباحث في العلوم الاجتماعية، تحرير: أحمد حسن، دار الفكر، عمّان، 2019، ص101-130.',
      },
      {
        id: 'lecun2015',
        output:
          'LeCun، Yann و Yoshua Bengio و Geoffrey Hinton. «Deep learning». Nature، مج521، ع7553، 2015، ص436-444.',
      },
    ]);
  });

  it('applies the customary placeholders and keeps literal (Hijri) dates', () => {
    const undated: CslItemInput = {
      id: 'u',
      type: 'book',
      title: 'كتاب بلا بيانات',
      author: [{ literal: 'مؤلف مجهول' }],
    };
    const hijri: CslItemInput = {
      id: 'h',
      type: 'book',
      title: 'تاريخ الطبري',
      author: [{ family: 'الطبري', given: 'محمد بن جرير' }],
      publisher: 'دار التراث',
      'publisher-place': 'بيروت',
      edition: 'الطبعة الثانية',
      issued: { literal: '1387هـ/1967م' },
    };
    expect(
      formatNotes([{ itemIds: ['u'] }, { itemIds: ['h'] }], [undated, hijri], options),
    ).toEqual([
      'مؤلف مجهول، كتاب بلا بيانات، د.ن، د.م، د.ت.',
      'محمد بن جرير الطبري، تاريخ الطبري، الطبعة الثانية، دار التراث، بيروت، 1387هـ/1967م.',
    ]);
  });

  it('abbreviates four or more authors and credits editors of authorless books', () => {
    const many: CslItemInput = {
      ...arArticle,
      id: 'many',
      author: [
        { family: 'أ', given: 'أحمد' },
        { family: 'ب', given: 'بكر' },
        { family: 'ج', given: 'جمال' },
        { family: 'د', given: 'داود' },
      ],
    };
    const edited: CslItemInput = {
      id: 'edited',
      type: 'book',
      title: 'أعمال المؤتمر',
      editor: [
        { family: 'حسن', given: 'أحمد' },
        { family: 'علي', given: 'منى' },
      ],
      publisher: 'دار الفكر',
      'publisher-place': 'القاهرة',
      issued: { 'date-parts': [[2018]] },
    };
    const notes = formatNotes(
      [{ itemIds: ['many'] }, { itemIds: ['edited'] }],
      [many, edited],
      options,
    );
    expect(notes[0]).toMatch(/^أحمد أ وآخرون، «/);
    expect(notes[1]).toBe('أحمد حسن ومنى علي (محررون)، أعمال المؤتمر، دار الفكر، القاهرة، 2018.');
  });

  it('renders HTML with escaping and bold titles', () => {
    const tricky: CslItemInput = {
      ...arBook,
      id: 'x',
      title: 'المقدمة <b>&</b>',
      volume: undefined,
    };
    const [note] = formatNotes([{ itemIds: ['x'] }], [tricky], { ...options, format: 'html' });
    expect(note).toBe(
      'عبد الرحمن ابن خلدون، <b>المقدمة &amp;</b>، تحقيق: عبد الله محمد الدرويش، ط1، دار يعرب، دمشق، 2004.',
    );
    const { output } = formatBibliography([{ ...arBook, id: 'a"b' }], {
      ...options,
      format: 'html',
    });
    expect(output).toBe(
      '<div class="csl-bib-body">\n  <div class="csl-entry" data-csl-entry-id="a&quot;b" dir="auto">ابن خلدون، عبد الرحمن. <b>المقدمة</b>. تحقيق: عبد الله محمد الدرويش، ط1، دار يعرب، دمشق، 2004.</div>\n</div>',
    );
  });

  it('ignores the locale option (labels are always Arabic) and is deterministic', () => {
    const cluster = { itemIds: ['ar-thesis'] };
    const ar = formatCitation(cluster, arabicItems, options);
    expect(formatCitation(cluster, arabicItems, { ...options, locale: 'en' })).toBe(ar);
    expect(formatCitation(cluster, [...arabicItems].reverse(), options)).toBe(ar);
  });
});
