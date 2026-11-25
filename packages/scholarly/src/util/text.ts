/**
 * Text normalisation and similarity used for matching bibliographic metadata.
 * Deterministic code only; no model is involved.
 */

// Arabic: tashkeel U+064B–U+065F, superscript alef U+0670, tatweel U+0640.
const ARABIC_MARKS = /[ً-ٰٟـ]/gu;
const ALEF_VARIANTS = /[أإآٱ]/gu;
// Latin (and other) combining diacritics exposed by NFKD.
const COMBINING_MARKS = /[̀-ͯ]/gu;
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/** Maps Arabic-Indic (U+0660–0669) and Extended Arabic-Indic (U+06F0–06F9) digits to ASCII. */
function asciiDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/gu, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/**
 * Normalises a string for comparison:
 * NFKC → Arabic normalisation (strip tashkeel U+064B–U+065F and U+0670, strip tatweel U+0640,
 * unify أ إ آ ٱ → ا, ى → ي, ة → ه, Arabic-Indic digits → ASCII) → NFKD and strip Latin
 * combining marks → lower case → punctuation and whitespace collapsed to single spaces.
 */
export function normalizeText(value: string): string {
  let text = value.normalize('NFKC');
  text = text
    .replace(ARABIC_MARKS, '')
    .replace(ALEF_VARIANTS, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/ة/gu, 'ه');
  text = asciiDigits(text);
  text = text.normalize('NFKD').replace(COMBINING_MARKS, '').normalize('NFC');
  return text.toLowerCase().replace(NON_WORD, ' ').trim();
}

export function tokens(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized === '' ? [] : normalized.split(' ');
}

/** Jaccard index of the two normalised token sets (1 = same words, order ignored). */
export function tokenJaccard(a: string, b: string): number {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Levenshtein distance over code points (two-row dynamic programming). */
export function levenshtein(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = new Array<number>(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length] ?? 0;
}

/** 1 − distance / longer length, on normalised strings (1 = identical). */
export function levenshteinRatio(a: string, b: string): number {
  const left = normalizeText(a);
  const right = normalizeText(b);
  const longest = Math.max(Array.from(left).length, Array.from(right).length);
  if (longest === 0) return 1;
  return 1 - levenshtein(left, right) / longest;
}

/** Longest title compared character by character; longer input is truncated (cost bound). */
const MAX_COMPARED_CHARS = 600;

/** Main title without its subtitle ("Title: Subtitle", "Title — Subtitle"). */
export function mainTitle(title: string): string {
  const match = /^(.+?)\s*(?:[:：؛]|\s[-–—]\s)/u.exec(title);
  return match?.[1] ?? title;
}

/**
 * Title similarity in [0, 1]: the maximum of token Jaccard (robust to word order) and the
 * Levenshtein ratio (robust to typos and transliteration noise), computed on the full titles
 * and on their main titles (citations often drop the subtitle).
 */
export function titleSimilarity(a: string, b: string): number {
  const left = a.slice(0, MAX_COMPARED_CHARS);
  const right = b.slice(0, MAX_COMPARED_CHARS);
  const pairs: [string, string][] = [
    [left, right],
    [mainTitle(left), mainTitle(right)],
    [left, mainTitle(right)],
    [mainTitle(left), right],
  ];
  let best = 0;
  for (const [x, y] of pairs) {
    if (normalizeText(x) === '' || normalizeText(y) === '') continue;
    best = Math.max(best, tokenJaccard(x, y), levenshteinRatio(x, y));
  }
  return Math.round(best * 1000) / 1000;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decodes numeric and the basic named HTML entities. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Inline tags are removed without a space so "H<sub>2</sub>O" stays "H2O". */
const INLINE_TAGS = new Set([
  'i',
  'b',
  'em',
  'strong',
  'sub',
  'sup',
  'span',
  'sc',
  'u',
  'italic',
  'bold',
]);

/**
 * Plain text from upstream markup (JATS abstracts, <i>/<sub> in titles): tags removed,
 * entities decoded, whitespace collapsed. The result is text, not HTML; render it escaped.
 */
export function stripMarkup(value: string): string {
  const withoutTags = value.replace(
    /<\/?([a-z][\w:.-]*)(?:\s[^<>]*)?\/?>/giu,
    (_tag, name: string) => (INLINE_TAGS.has(name.toLowerCase().replace(/^.*:/u, '')) ? '' : ' '),
  );
  return decodeEntities(withoutTags).replace(/\s+/gu, ' ').trim();
}

/** Clean optional upstream text: undefined for null/blank. */
export function cleanText(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = stripMarkup(value);
  return text === '' ? undefined : text;
}
