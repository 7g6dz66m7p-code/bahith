import type { CslItemInput } from '../src/index';

/**
 * Test fixtures. The English items are real publications. The Arabic items are
 * SYNTHETIC: modelled on common Arabic publication patterns to exercise formatting,
 * not records of real works. Synthetic DOIs use Crossref's reserved test prefix 10.5555.
 */

export const lecun = {
  id: 'lecun2015',
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
  DOI: '10.1038/nature14539',
  issued: { 'date-parts': [[2015]] },
} satisfies CslItemInput;

export const creswell = {
  id: 'creswell2018',
  type: 'book',
  title: 'Research design: Qualitative, quantitative, and mixed methods approaches',
  author: [
    { family: 'Creswell', given: 'John W.' },
    { family: 'Creswell', given: 'J. David' },
  ],
  edition: '5',
  publisher: 'SAGE Publications',
  'publisher-place': 'Thousand Oaks, CA',
  issued: { 'date-parts': [[2018]] },
} satisfies CslItemInput;

export const braun = {
  id: 'braun2012',
  type: 'chapter',
  title: 'Thematic analysis',
  author: [
    { family: 'Braun', given: 'Virginia' },
    { family: 'Clarke', given: 'Victoria' },
  ],
  editor: [{ family: 'Cooper', given: 'Harris' }],
  'container-title': 'APA handbook of research methods in psychology',
  volume: '2',
  page: '57-71',
  publisher: 'American Psychological Association',
  'publisher-place': 'Washington, DC',
  DOI: '10.1037/13620-004',
  issued: { 'date-parts': [[2012]] },
} satisfies CslItemInput;

export const shannon = {
  id: 'shannon1940',
  type: 'thesis',
  genre: "Master's thesis",
  title: 'A symbolic analysis of relay and switching circuits',
  author: [{ family: 'Shannon', given: 'Claude E.' }],
  publisher: 'Massachusetts Institute of Technology',
  'publisher-place': 'Cambridge, MA',
  issued: { 'date-parts': [[1940]] },
} satisfies CslItemInput;

/** Synthetic Arabic journal article with a test-prefix DOI. */
export const arArticle = {
  id: 'ar-article',
  type: 'article-journal',
  language: 'ar',
  title: 'أثر التعلم الإلكتروني في التحصيل الدراسي',
  author: [
    { family: 'العتيبي', given: 'سارة' },
    { family: 'الحربي', given: 'خالد' },
  ],
  'container-title': 'مجلة العلوم التربوية',
  volume: '12',
  issue: '3',
  page: '45-67',
  DOI: '10.5555/ar.2020.003',
  issued: { 'date-parts': [[2020]] },
} satisfies CslItemInput;

/** Synthetic Arabic book with a critical editor (تحقيق). */
export const arBook = {
  id: 'ar-book',
  type: 'book',
  language: 'ar',
  title: 'المقدمة',
  author: [{ family: 'ابن خلدون', given: 'عبد الرحمن' }],
  editor: [{ family: 'الدرويش', given: 'عبد الله محمد' }],
  edition: '1',
  publisher: 'دار يعرب',
  'publisher-place': 'دمشق',
  volume: '1',
  issued: { 'date-parts': [[2004]] },
} satisfies CslItemInput;

/** Synthetic Arabic book chapter. */
export const arChapter = {
  id: 'ar-chapter',
  type: 'chapter',
  language: 'ar',
  title: 'مناهج البحث النوعي',
  author: [{ family: 'المصري', given: 'ليلى' }],
  editor: [{ family: 'حسن', given: 'أحمد' }],
  'container-title': 'دليل الباحث في العلوم الاجتماعية',
  page: '101-130',
  publisher: 'دار الفكر',
  'publisher-place': 'عمّان',
  issued: { 'date-parts': [[2019]] },
} satisfies CslItemInput;

/** Synthetic Arabic doctoral thesis. */
export const arThesis = {
  id: 'ar-thesis',
  type: 'thesis',
  language: 'ar',
  genre: 'رسالة دكتوراه',
  title: 'التحول الرقمي في التعليم الجامعي',
  author: [{ family: 'الشمري', given: 'نورة' }],
  publisher: 'جامعة الملك سعود',
  'publisher-place': 'الرياض',
  issued: { 'date-parts': [[2021]] },
} satisfies CslItemInput;

export const englishItems = [lecun, creswell, braun, shannon];
export const arabicItems = [arArticle, arBook, arChapter, arThesis];
export const allItems = [...englishItems, ...arabicItems];
