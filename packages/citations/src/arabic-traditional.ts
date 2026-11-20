/**
 * «التوثيق التقليدي» — traditional Arabic/Islamic-studies citation.
 *
 * IN-HOUSE CONVENTION. There is no official CSL style for this tradition and no single
 * authoritative manual; this module implements one fixed, documented convention
 * (version `bahith-arabic-traditional/1`) as deterministic TypeScript. Any change to
 * the output is a breaking change for stored documents and must bump the version and
 * update the golden tests.
 *
 * Footnote, first citation (fields are omitted when absent, joined by the Arabic comma):
 *
 *   book      المؤلف، العنوان، تحقيق: المحقق، ترجمة: المترجم، ط2، الناشر، المكان، السنة، ج1، ص45.
 *   chapter   المؤلف، «عنوان الفصل»، في: عنوان الكتاب، تحرير: المحرر، الناشر، المكان، السنة، ص45.
 *   article   المؤلف، «عنوان المقال»، المجلة، مج12، ع3، السنة، ص45.
 *   thesis    المؤلف، العنوان، رسالة دكتوراه، الجامعة، المكان، السنة، ص45.
 *
 * Subsequent citations: «المرجع نفسه، ص46.» when the previous note cites the same single
 * item, otherwise a short form «الجابري، نقد العقل العربي، ص46.».
 *
 * Bibliography entry: «الجابري، محمد عابد. نقد العقل العربي. ط10، مركز دراسات الوحدة
 * العربية، بيروت، 2009.» (articles and chapters end with their page range). Arabic-script entries are listed first, then the rest; each
 * group is sorted by normalised family name ignoring the article «ال».
 *
 * Rules:
 * - Names: «given family» in notes; the first author is inverted «family، given» in the
 *   bibliography. Two or three authors are joined with «و» (attached to an Arabic name,
 *   spaced before a Latin one); four or more become «الأول وآخرون».
 * - `editor` of a book that has an author is the critical editor (تحقيق:). A book with no
 *   author is credited to its editors: «المحرر (محرر)». For chapters `editor` is the
 *   editor of the containing book (تحرير:).
 * - Edition: numeric → «ط10»; any other text is printed as given («الطبعة الثانية»).
 * - Missing date → «د.ت»; for books and chapters a missing publisher → «د.ن» and a
 *   missing place → «د.م» (the customary abbreviations).
 * - `issued.literal` is printed verbatim, so dual dates such as «1425هـ/2004م» are kept.
 * - Locators: page → «ص», volume → «ج», folio → «ق»; other labels use an Arabic word.
 *   An item's own `volume` (a multi-volume work) prints as «ج» before the page.
 * - Digits are printed as stored (no conversion between Western and Arabic-Indic).
 * - Labels are always Arabic: the `locale` option does not change this style.
 * - HTML output escapes all text and marks book and journal titles with <b>.
 */
import { hasArabicScript, matchKey, stripCslMarkup } from './arabic';
import type { CslDate, CslItem, CslName, LocatorLabel } from './schema';
import type { OutputFormat } from './styles';

export const ARABIC_TRADITIONAL_VERSION = 'bahith-arabic-traditional/1';

const COMMA = '، ';
const AND = ' و';

const TERMS = {
  edited: 'تحقيق: ',
  editorOf: 'تحرير: ',
  translated: 'ترجمة: ',
  in: 'في: ',
  etAl: ' وآخرون',
  editorSingle: ' (محرر)',
  editorPlural: ' (محررون)',
  edition: 'ط',
  volume: 'ج',
  page: 'ص',
  journalVolume: 'مج',
  issue: 'ع',
  noDate: 'د.ت',
  noPublisher: 'د.ن',
  noPlace: 'د.م',
  ibid: 'المرجع نفسه',
  quoteOpen: '«',
  quoteClose: '»',
} as const;

/** Abbreviated labels are written without a space («ص45»), words with one («الفصل 3»). */
const LOCATOR_TERMS: Partial<Record<LocatorLabel, { term: string; spaced: boolean }>> = {
  page: { term: TERMS.page, spaced: false },
  volume: { term: TERMS.volume, spaced: false },
  folio: { term: 'ق', spaced: false },
  chapter: { term: 'الفصل', spaced: true },
  section: { term: 'القسم', spaced: true },
  paragraph: { term: 'الفقرة', spaced: true },
  line: { term: 'السطر', spaced: true },
  note: { term: 'الحاشية', spaced: true },
  verse: { term: 'الآية', spaced: true },
  part: { term: 'الجزء', spaced: true },
  figure: { term: 'الشكل', spaced: true },
  table: { term: 'الجدول', spaced: true },
  issue: { term: TERMS.issue, spaced: false },
};

export interface ArabicCite {
  readonly item: CslItem;
  readonly locator?: string;
  readonly label?: LocatorLabel;
}

/** A piece of output: plain text, or a title that HTML output marks in bold. */
type Part = string | { readonly title: string };

const BOOK_LIKE = new Set<CslItem['type']>(['book', 'classic', 'manuscript', 'pamphlet', 'report']);
const CHAPTER_LIKE = new Set<CslItem['type']>([
  'chapter',
  'entry',
  'entry-dictionary',
  'entry-encyclopedia',
  'paper-conference',
]);
const ARTICLE_LIKE = new Set<CslItem['type']>([
  'article',
  'article-journal',
  'article-magazine',
  'article-newspaper',
  'review',
  'review-book',
]);

function plain(value: string | undefined): string | undefined {
  return value === undefined ? undefined : stripCslMarkup(value).trim() || undefined;
}

function nameNatural(name: CslName): string {
  if (name.literal !== undefined) {
    return name.literal;
  }
  return [
    name.given,
    name['dropping-particle'],
    name['non-dropping-particle'],
    name.family,
    name.suffix,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');
}

function nameInverted(name: CslName): string {
  if (name.literal !== undefined) {
    return name.literal;
  }
  const family = [name['non-dropping-particle'], name.family]
    .filter((part): part is string => part !== undefined)
    .join(' ');
  const given = [name.given, name['dropping-particle']]
    .filter((part): part is string => part !== undefined)
    .join(' ');
  return [family, given, name.suffix]
    .filter((part) => part !== '' && part !== undefined)
    .join(COMMA);
}

function joinNames(names: readonly CslName[], invertFirst: boolean): string {
  const rendered = names.map((name, index) =>
    index === 0 && invertFirst ? nameInverted(name) : nameNatural(name),
  );
  if (rendered.length >= 4) {
    return `${rendered[0] ?? ''}${TERMS.etAl}`;
  }
  // «و» is written joined to an Arabic name («وخالد») and spaced before a Latin one.
  return rendered.reduce((out, name) =>
    hasArabicScript(name.charAt(0)) ? `${out}${AND}${name}` : `${out}${AND} ${name}`,
  );
}

function year(date: CslDate | undefined): string {
  if (date?.literal !== undefined) {
    return date.literal;
  }
  const first = date?.['date-parts']?.[0]?.[0];
  if (first !== undefined) {
    return String(first);
  }
  return date?.raw ?? TERMS.noDate;
}

function edition(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return /^\d+$/.test(value) ? `${TERMS.edition}${value}` : value;
}

function locatorText(locator: string, label: LocatorLabel): string {
  const term = LOCATOR_TERMS[label];
  if (term === undefined) {
    return locator;
  }
  return term.spaced ? `${term.term} ${locator}` : `${term.term}${locator}`;
}

function quoted(title: string): string {
  return `${TERMS.quoteOpen}${title}${TERMS.quoteClose}`;
}

/** Responsibility statement: authors, or (for an authorless book) editors as authors. */
function responsibility(item: CslItem, invertFirst: boolean): string | undefined {
  if (item.author !== undefined) {
    return joinNames(item.author, invertFirst);
  }
  if (BOOK_LIKE.has(item.type) && item.editor !== undefined) {
    const suffix = item.editor.length > 1 ? TERMS.editorPlural : TERMS.editorSingle;
    return `${joinNames(item.editor, invertFirst)}${suffix}`;
  }
  return undefined;
}

/** Fields after the title, shared by notes and the bibliography. */
function publicationParts(item: CslItem): Part[] {
  const parts: Part[] = [];
  const add = (value: string | undefined): void => {
    if (value !== undefined) {
      parts.push(value);
    }
  };
  const container = plain(item['container-title']);

  if (ARTICLE_LIKE.has(item.type)) {
    if (container !== undefined) {
      parts.push({ title: container });
    }
    add(item.volume === undefined ? undefined : `${TERMS.journalVolume}${item.volume}`);
    add(item.issue === undefined ? undefined : `${TERMS.issue}${item.issue}`);
    add(year(item.issued));
    return parts;
  }

  const isChapter = CHAPTER_LIKE.has(item.type);
  if (isChapter && container !== undefined) {
    parts.push(TERMS.in, { title: container });
  }
  if (item.editor !== undefined && (isChapter || item.author !== undefined)) {
    add(`${isChapter ? TERMS.editorOf : TERMS.edited}${joinNames(item.editor, false)}`);
  }
  if (item.translator !== undefined) {
    add(`${TERMS.translated}${joinNames(item.translator, false)}`);
  }
  add(item.type === 'thesis' ? plain(item.genre) : undefined);
  add(edition(item.edition));

  const customary = BOOK_LIKE.has(item.type) || isChapter;
  add(plain(item.publisher) ?? (customary ? TERMS.noPublisher : undefined));
  add(plain(item['publisher-place']) ?? (customary ? TERMS.noPlace : undefined));
  add(year(item.issued));
  return parts;
}

function titlePart(item: CslItem): Part | undefined {
  const title = plain(item.title);
  if (title === undefined) {
    return undefined;
  }
  return ARTICLE_LIKE.has(item.type) || CHAPTER_LIKE.has(item.type) ? quoted(title) : { title };
}

function shortTitlePart(item: CslItem): Part | undefined {
  const short = plain(item['title-short']);
  if (short === undefined) {
    return titlePart(item);
  }
  return ARTICLE_LIKE.has(item.type) || CHAPTER_LIKE.has(item.type)
    ? quoted(short)
    : { title: short };
}

function pinpoint(cite: ArabicCite, withRange: boolean): Part[] {
  const parts: Part[] = [];
  const label = cite.label ?? 'page';
  if (cite.item.volume !== undefined && !ARTICLE_LIKE.has(cite.item.type) && label !== 'volume') {
    parts.push(`${TERMS.volume}${cite.item.volume}`);
  }
  if (cite.locator !== undefined) {
    parts.push(locatorText(cite.locator, label));
  } else if (withRange && cite.item.page !== undefined) {
    parts.push(`${TERMS.page}${cite.item.page}`);
  }
  return parts;
}

/** Joins parts with the Arabic comma; the «في: » prefix attaches to the next part. */
function joinParts(parts: readonly Part[], format: OutputFormat): string {
  let out = '';
  let attach = false;
  parts.forEach((part, index) => {
    const rendered = renderPart(part, format);
    if (index > 0 && !attach) {
      out += COMMA;
    }
    out += rendered;
    attach = part === TERMS.in;
  });
  return out;
}

function renderPart(part: Part, format: OutputFormat): string {
  if (typeof part === 'string') {
    return format === 'html' ? escapeHtml(part) : part;
  }
  return format === 'html' ? `<b>${escapeHtml(part.title)}</b>` : part.title;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function terminate(text: string): string {
  return /[.!?؟]$/.test(text) ? text : `${text}.`;
}

function familyOf(item: CslItem): string | undefined {
  const first = item.author?.[0] ?? (BOOK_LIKE.has(item.type) ? item.editor?.[0] : undefined);
  return first === undefined ? undefined : (first.family ?? first.literal);
}

/** The full (first-citation) form of one cite, without the final period. */
function fullCite(cite: ArabicCite, format: OutputFormat): string {
  const parts: Part[] = [];
  const who = responsibility(cite.item, false);
  if (who !== undefined) {
    parts.push(who);
  }
  const title = titlePart(cite.item);
  if (title !== undefined) {
    parts.push(title);
  }
  parts.push(...publicationParts(cite.item), ...pinpoint(cite, true));
  return joinParts(parts, format);
}

/** The short (subsequent-citation) form: family name, short title, pinpoint. */
function shortCite(cite: ArabicCite, format: OutputFormat): string {
  const parts: Part[] = [];
  const family = familyOf(cite.item);
  if (family !== undefined) {
    parts.push(family);
  }
  const title = shortTitlePart(cite.item);
  if (title !== undefined) {
    parts.push(title);
  }
  parts.push(...pinpoint(cite, false));
  return joinParts(parts, format);
}

/**
 * Renders a sequence of footnotes in document order. The first citation of an item is
 * full; later ones are short, and a note that repeats the single item of the note
 * immediately before it becomes «المرجع نفسه». Several cites in one note are joined
 * by the Arabic semicolon.
 */
export function arabicTraditionalNotes(
  notes: readonly (readonly ArabicCite[])[],
  format: OutputFormat,
): string[] {
  const seen = new Set<string>();
  let previousId: string | undefined;
  return notes.map((cites) => {
    const [only] = cites;
    let output: string;
    if (cites.length === 1 && only !== undefined && only.item.id === previousId) {
      output = joinParts([TERMS.ibid, ...pinpoint(only, false)], format);
    } else {
      output = cites
        .map((cite) => (seen.has(cite.item.id) ? shortCite(cite, format) : fullCite(cite, format)))
        .join('\u061B ');
    }
    for (const cite of cites) {
      seen.add(cite.item.id);
    }
    previousId = cites.length === 1 ? only?.item.id : undefined;
    return terminate(output);
  });
}

function sortKey(item: CslItem): [number, string] {
  const family = familyOf(item) ?? plain(item.title) ?? '';
  const group = hasArabicScript(family) ? 0 : 1;
  const key = matchKey(family).replace(/^ال/u, '');
  return [group, key];
}

/** Deterministic code-point comparison (no ICU collation, so identical on every host). */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function arabicTraditionalBibliography(
  items: readonly CslItem[],
  format: OutputFormat,
): { id: string; output: string }[] {
  const sorted = [...items].sort((a, b) => {
    const [ga, ka] = sortKey(a);
    const [gb, kb] = sortKey(b);
    return (
      ga - gb ||
      compare(ka, kb) ||
      compare(matchKey(a.title ?? ''), matchKey(b.title ?? '')) ||
      compare(year(a.issued), year(b.issued)) ||
      compare(a.id, b.id)
    );
  });
  return sorted.map((item) => {
    const sections: string[] = [];
    const who = responsibility(item, true);
    if (who !== undefined) {
      sections.push(renderPart(who, format));
    }
    const title = titlePart(item);
    if (title !== undefined) {
      sections.push(renderPart(title, format));
    }
    const rest = publicationParts(item);
    if ((ARTICLE_LIKE.has(item.type) || CHAPTER_LIKE.has(item.type)) && item.page !== undefined) {
      rest.push(`${TERMS.page}${item.page}`);
    }
    if (rest.length > 0) {
      sections.push(joinParts(rest, format));
    }
    return { id: item.id, output: terminate(sections.map((s) => s.replace(/\.$/, '')).join('. ')) };
  });
}
