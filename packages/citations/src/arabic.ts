/**
 * Arabic text normalisation, pure and deterministic.
 *
 * `normalizeArabic` mirrors the database function `app.normalize_arabic`
 * (packages/db/migrations/0000_foundation.sql) character for character, so a title
 * matched here is matched the same way by full-text search. Keep the two in sync.
 */

/** Tashkeel U+064B-U+065F, superscript alef U+0670 and tatweel U+0640, as in the SQL. */
const STRIPPED = /[\u064B-\u065F\u0670\u0640]/g;

/** Position N of FROM maps to position N of TO (same table as `app.normalize_arabic`). */
const FROM =
  '\u0623\u0625\u0622\u0671\u0624\u0626\u0649\u0629\u06CC\u06A9' +
  '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669' +
  '\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9';
const TO =
  '\u0627\u0627\u0627\u0627\u0648\u064A\u064A\u0647\u064A\u0643' + '0123456789' + '0123456789';

const MAP = new Map<string, string>(Array.from(FROM, (char, index) => [char, TO.charAt(index)]));

/**
 * Removes tashkeel and tatweel and unifies alef (أ إ آ ٱ → ا), hamza carriers
 * (ؤ → و، ئ → ي), alef maqsura (ى → ي), teh marbuta (ة → ه), Persian yeh/kaf and
 * Arabic-Indic/Persian digits. Latin text is untouched.
 */
export function normalizeArabic(input: string): string {
  let out = '';
  for (const char of input.replace(STRIPPED, '')) {
    out += MAP.get(char) ?? char;
  }
  return out;
}

const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u;

/** True when the text contains at least one Arabic-script letter. */
export function hasArabicScript(input: string): boolean {
  return ARABIC_SCRIPT.test(input);
}

/** CSL rich-text markup (`<i>`, `<b>`, `<sup>`, `<sub>`, `<span class="nocase">` …). */
const CSL_MARKUP = /<\/?(?:i|b|sc|sup|sub|span)(?:\s[^>]*)?>/gi;

/** Removes CSL rich-text tags, leaving their text. */
export function stripCslMarkup(input: string): string {
  return input.replace(CSL_MARKUP, '');
}

/**
 * A comparison key: presentation forms folded (NFKC), Arabic normalised, Latin
 * diacritics removed, case folded, punctuation and symbols turned into spaces, and
 * whitespace collapsed.
 */
export function matchKey(input: string): string {
  return normalizeArabic(stripCslMarkup(input).normalize('NFKC'))
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
