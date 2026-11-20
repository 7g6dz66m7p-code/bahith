import type { Block, ExportDocument, ExportTemplate } from '../src';

/*
 * SYNTHETIC TEST TEXT. Every Arabic and English sentence below was written for these
 * tests as filler; none is quoted from, or attributed to, a real publication. The
 * "citations" and bibliography entries are fictitious placeholders that exercise
 * layout only.
 */

/**
 * Fully vocalised (tashkeel) sentence «إِنَّ البَحْثَ العِلْمِيَّ أَسَاسُ المَعْرِفَةِ», spelled
 * with escapes so the mark order is explicit: shadda (U+0651) is typed BEFORE fatha
 * (U+064E), which is not canonical (NFC/NFD would swap them). Any normalisation on
 * the way to the file therefore changes the bytes and fails the test.
 */
export const TASHKEEL =
  '\u0625\u0650\u0646\u0651\u064E \u0627\u0644\u0628\u064E\u062D\u0652\u062B\u064E ' +
  '\u0627\u0644\u0639\u0650\u0644\u0652\u0645\u0650\u064A\u0651\u064E ' +
  '\u0623\u064E\u0633\u064E\u0627\u0633\u064F ' +
  '\u0627\u0644\u0645\u064E\u0639\u0652\u0631\u0650\u0641\u064E\u0629\u0650';
export const CITATION_TEXT = '(الباحث، ٢٠٢٠، ص. ١٥)';
export const FOOTNOTE_TEXT = 'هذه حاشية تجريبية للاختبار.';
export const ENGLISH_PARAGRAPH = 'This paragraph is written in English inside an Arabic thesis.';

/** A 4×3 red PNG (generated with zlib; no external asset). */
export const PNG_4X3 = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGP4z8AARww4OQD1MQv1NXv7ggAAAABJRU5ErkJggg==',
    'base64',
  ),
);

export const arabicTemplate: ExportTemplate = {
  id: 'thesis-default',
  pageSize: 'A4',
  margins: { top: 25, bottom: 25, start: 30, end: 25 },
  fontFamily: 'Noto Naskh Arabic',
  fontSizePt: 14,
  lineSpacing: 1.5,
  coverPage: true,
  tableOfContents: true,
  pageNumbers: true,
};

export function sampleArabicDocument(overrides: Partial<ExportDocument> = {}): ExportDocument {
  const body: Block[] = [
    { type: 'heading', level: 1, text: 'الفصل الأول: مقدمة الدراسة' },
    {
      type: 'paragraph',
      runs: [
        { type: 'text', text: `${TASHKEEL}، ` },
        { type: 'text', text: 'وهذه جملة عريضة', bold: true },
        { type: 'text', text: ' تتبعها ' },
        { type: 'text', text: 'جملة مائلة', italic: true },
        { type: 'text', text: ' ' },
        { type: 'citation', text: CITATION_TEXT, sourceId: 'src-1', locator: 'ص. ١٥' },
        { type: 'text', text: '.' },
        { type: 'footnote', content: [{ type: 'text', text: FOOTNOTE_TEXT }] },
      ],
    },
    { type: 'paragraph', dir: 'ltr', runs: [{ type: 'text', text: ENGLISH_PARAGRAPH }] },
    { type: 'heading', level: 2, text: 'المبحث الأول: مشكلة الدراسة' },
    { type: 'heading', level: 3, text: 'المطلب الأول: أسئلة الدراسة' },
    {
      type: 'blockquote',
      runs: [{ type: 'text', text: 'نص مقتبس تجريبي يوضع بين علامتي تنصيص.' }],
    },
    {
      type: 'list',
      ordered: true,
      items: [[{ type: 'text', text: 'السؤال الأول' }], [{ type: 'text', text: 'السؤال الثاني' }]],
    },
    {
      type: 'list',
      ordered: false,
      items: [[{ type: 'text', text: 'نقطة أولى' }], [{ type: 'text', text: 'نقطة ثانية' }]],
    },
    {
      type: 'table',
      caption: 'جدول تجريبي',
      header: ['المتغير', 'القيمة'],
      rows: [
        ['العينة', '١٢٠'],
        ['المدة', '٦ أشهر'],
      ],
    },
    { type: 'image', data: PNG_4X3, mime: 'image/png', alt: 'شكل تجريبي', caption: 'شكل ١' },
    { type: 'equation', latex: '\\frac{a}{b} + x^{2}' },
    {
      type: 'equation',
      latex: '\\begin{matrix} a & b \\end{matrix}',
      fallbackText: 'matrix(a, b)',
    },
    { type: 'heading', level: 1, text: 'الفصل الثاني: الإطار النظري' },
    {
      type: 'paragraph',
      runs: [
        { type: 'text', text: 'فقرة في الفصل الثاني' },
        { type: 'footnote', content: [{ type: 'text', text: 'حاشية الفصل الثاني.' }] },
      ],
    },
  ];
  return {
    meta: {
      title: 'أثر التعلم المدمج في التحصيل',
      subtitle: 'دراسة تجريبية',
      author: 'باحث تجريبي',
      supervisor: 'مشرف تجريبي',
      institution: 'جامعة تجريبية',
      department: 'قسم المناهج',
      degree: 'رسالة ماجستير',
      date: '١٤٤٦هـ / ٢٠٢٥م',
      language: 'ar',
      direction: 'rtl',
    },
    template: arabicTemplate,
    body,
    bibliography: {
      heading: 'المراجع',
      entries: [
        'الباحث، أ. (٢٠٢٠). عنوان كتاب تجريبي. دار النشر التجريبية.',
        'Author, A. (2019). A fictitious English reference. Test Press.',
      ],
    },
    ...overrides,
  };
}

/*
 * SYNTHETIC lorem-style Arabic filler (written for this test, not a real text), used to
 * build a long thesis-shaped document.
 */
const LOREM_AR = [
  'يتناول هذا المقطع التجريبي موضوعاً افتراضياً يهدف إلى ملء الصفحة بنص عربي متصل يشبه فقرات الرسائل الجامعية في طوله وبنيته.',
  'وتعرض الفقرة أفكاراً متتابعة حول منهج البحث وأدواته وحدوده، دون أن تنسب أي نتيجة إلى دراسة حقيقية أو مؤلف حقيقي.',
  'ثم ينتقل النص إلى مناقشة عامة للمفاهيم الأساسية، مع تكرار مقصود للعبارات حتى يصل المستند إلى عدد كافٍ من الصفحات.',
  'وتختتم الفقرة بخلاصة قصيرة تمهد للمطلب التالي، وتحافظ على اتجاه الكتابة من اليمين إلى اليسار في جميع الأسطر.',
].join(' ');

/** ~30 A4 pages: 5 chapters × 3 sections × 2 subsections × 4 paragraphs, footnote each. */
export function syntheticThesis(): ExportDocument {
  const ordinal = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس'];
  const body: Block[] = [];
  let note = 0;
  for (let c = 0; c < 5; c += 1) {
    body.push({ type: 'heading', level: 1, text: `الفصل ${ordinal[c] ?? ''}: فصل تجريبي` });
    for (let s = 0; s < 3; s += 1) {
      body.push({
        type: 'heading',
        level: 2,
        text: `المبحث ${ordinal[s] ?? ''} من الفصل ${c + 1}`,
      });
      for (let m = 0; m < 2; m += 1) {
        body.push({
          type: 'heading',
          level: 3,
          text: `المطلب ${ordinal[m] ?? ''} من المبحث ${s + 1} في الفصل ${c + 1}`,
        });
        for (let p = 0; p < 4; p += 1) {
          note += 1;
          body.push({
            type: 'paragraph',
            runs: [
              { type: 'text', text: LOREM_AR },
              {
                type: 'footnote',
                content: [{ type: 'text', text: `حاشية تجريبية رقم ${note}.` }],
              },
            ],
          });
        }
      }
    }
  }
  const base = sampleArabicDocument();
  return { ...base, meta: { ...base.meta, title: 'رسالة تجريبية طويلة' }, body };
}
