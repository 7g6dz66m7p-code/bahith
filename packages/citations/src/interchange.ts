/**
 * BibTeX and RIS import/export (via @citation-js/plugin-bibtex and plugin-ris).
 *
 * Imports return validated CSL-JSON. Malformed input raises a `CitationError` with a
 * stable code; its message and details never contain input text.
 */
import { CitationError } from './errors';
import {
  CSL_TYPES,
  cslItemSchema,
  LIMITS,
  toIssues,
  validateItems,
  type CslItem,
  type CslItemInput,
  type CslName,
} from './schema';
import {
  formatBibtexText,
  formatRisRecords,
  parseInterchange,
  type InterchangeFormat,
} from './vendor';

/** Largest accepted BibTeX/RIS text, in UTF-16 code units (about 5 MB of ASCII). */
export const MAX_INTERCHANGE_CHARS = 5_000_000;

const KNOWN_TYPES: ReadonlySet<string> = new Set(CSL_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parse(text: unknown, format: InterchangeFormat): CslItem[] {
  if (typeof text !== 'string') {
    throw new CitationError('CITATION_INVALID_INPUT', {
      issues: [{ path: ['text'], code: 'invalid_type' }],
    });
  }
  if (text.length > MAX_INTERCHANGE_CHARS) {
    throw new CitationError('CITATION_INPUT_TOO_LARGE');
  }
  const source = text.replace(/^\uFEFF/, '');
  if (source.trim() === '') {
    throw new CitationError('CITATION_EMPTY_INPUT');
  }
  const raw = parseInterchange(source, format);
  if (raw.length === 0) {
    throw new CitationError('CITATION_NO_ENTRIES');
  }
  if (raw.length > LIMITS.items) {
    throw new CitationError('CITATION_INPUT_TOO_LARGE');
  }

  const usedIds = new Set<string>();
  return raw.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new CitationError('CITATION_PARSE_FAILED', { index });
    }
    const candidate: Record<string, unknown> = { ...entry };
    candidate.type =
      typeof entry.type === 'string' && KNOWN_TYPES.has(entry.type) ? entry.type : 'document';
    candidate.id = uniqueId(entry, index, format, usedIds);
    const result = cslItemSchema.safeParse(candidate);
    if (!result.success) {
      throw new CitationError('CITATION_INVALID_INPUT', {
        index,
        issues: toIssues(result.error, ['entries', index]),
      });
    }
    return result.data;
  });
}

/**
 * The entry key (BibTeX), ID tag (RIS) or item id (CSL-JSON) when present, else `<format>-<n>`. Repeated keys
 * get a `-2`, `-3`… suffix so every returned item has a distinct id.
 */
function uniqueId(
  entry: Record<string, unknown>,
  index: number,
  format: InterchangeFormat | 'csl',
  used: Set<string>,
): string {
  const declared = [entry.id, entry['citation-key']].find(
    (value): value is string | number =>
      (typeof value === 'string' && value.trim() !== '') || typeof value === 'number',
  );
  const base =
    declared === undefined
      ? `${format}-${index + 1}`
      : String(declared)
          .trim()
          .slice(0, LIMITS.id - 8);
  let id = base;
  for (let n = 2; used.has(id); n += 1) {
    id = `${base}-${n}`;
  }
  used.add(id);
  return id;
}

/** Parses BibTeX/BibLaTeX text (UTF-8, Arabic included) into CSL-JSON items. */
export function parseBibtex(text: string): CslItem[] {
  return parse(text, 'bibtex');
}

/** Parses RIS text into CSL-JSON items. */
export function parseRis(text: string): CslItem[] {
  return parse(text, 'ris');
}

/** The CSL-JSON items of a parsed JSON value: an array, or Zotero's `{ "items": [...] }`. */
function cslJsonEntries(value: unknown): readonly unknown[] | null {
  const list: unknown = isRecord(value) ? value.items : value;
  return Array.isArray(list) ? (list as readonly unknown[]) : null;
}

function looksLikeCslItem(value: unknown): boolean {
  return isRecord(value) && (typeof value.type === 'string' || typeof value.title === 'string');
}

/**
 * Which interchange format a bibliography file is in. CSL-JSON (what Zotero and most
 * reference managers export as "CSL JSON") is a JSON array of objects with a `type` or
 * `title`; RIS starts records with `TY  -`; anything else is treated as BibTeX.
 */
export function detectInterchangeFormat(text: string): 'csl-json' | 'ris' | 'bibtex' {
  const source = text.replace(/^\uFEFF/, '').trimStart();
  if (source.startsWith('[') || source.startsWith('{')) {
    try {
      const entries = cslJsonEntries(JSON.parse(source));
      if (entries !== null && entries.length > 0 && entries.some(looksLikeCslItem)) {
        return 'csl-json';
      }
    } catch {
      // Not JSON: fall through to the text formats.
    }
  }
  return /^\s*TY\s{2}-/mu.test(source) ? 'ris' : 'bibtex';
}

export interface CslJsonImport {
  /** Valid items, with unknown types mapped to `document` and unique ids. */
  items: CslItem[];
  /** Entries that were not CSL items or failed validation (skipped, not fatal). */
  invalid: number;
}

/**
 * Parses CSL-JSON: text, or an already-parsed JSON value (a Zotero Web API
 * `format=csljson` response). Unlike BibTeX/RIS, one malformed entry does not reject the
 * whole file: real libraries carry odd records, so they are counted in `invalid` and
 * skipped. CSL-JSON is the native item format of citation-js and citeproc, so no
 * conversion plugin is involved: items are validated by {@link cslItemSchema} only.
 */
export function parseCslJson(input: unknown): CslJsonImport {
  let value = input;
  if (typeof input === 'string') {
    if (input.length > MAX_INTERCHANGE_CHARS) throw new CitationError('CITATION_INPUT_TOO_LARGE');
    const source = input.replace(/^\uFEFF/, '');
    if (source.trim() === '') throw new CitationError('CITATION_EMPTY_INPUT');
    try {
      value = JSON.parse(source);
    } catch {
      // The SyntaxError message quotes the input, so it is not attached.
      throw new CitationError('CITATION_PARSE_FAILED');
    }
  }
  const entries = cslJsonEntries(value);
  if (entries === null) {
    throw new CitationError('CITATION_INVALID_INPUT', {
      issues: [{ path: [], code: 'invalid_type' }],
    });
  }
  if (entries.length === 0) throw new CitationError('CITATION_NO_ENTRIES');
  if (entries.length > LIMITS.items) throw new CitationError('CITATION_INPUT_TOO_LARGE');

  const usedIds = new Set<string>();
  const items: CslItem[] = [];
  let invalid = 0;
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) {
      invalid += 1;
      return;
    }
    const candidate: Record<string, unknown> = {
      ...entry,
      type: typeof entry.type === 'string' && KNOWN_TYPES.has(entry.type) ? entry.type : 'document',
    };
    candidate.id = uniqueId(entry, index, 'csl', usedIds);
    const result = cslItemSchema.safeParse(candidate);
    if (result.success) items.push(result.data);
    else invalid += 1;
  });
  return { items, invalid };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Fields BibTeX stores verbatim (no escaping) or that are identifiers, not prose. */
const UNESCAPED_FIELDS = new Set(['id', 'type', 'citation-key', 'DOI', 'URL', 'language']);

const LATEX_SPECIALS: Readonly<Record<string, string>> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

function escapeLatex(value: string): string {
  return value.replace(/[\\{}&%$#_~^]/g, (char) => LATEX_SPECIALS[char] ?? char);
}

/** Collapses line breaks and runs of whitespace (RIS is line-oriented). */
function singleLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function mapStrings(item: CslItem, fn: (value: string, field: string) => string): CslItem {
  const mapName = (name: CslName): CslName =>
    Object.fromEntries(
      Object.entries(name).map(([key, value]) => [
        key,
        value === undefined ? value : fn(value, key),
      ]),
    );
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(item)) {
    if (typeof value === 'string') {
      out[field] = UNESCAPED_FIELDS.has(field) ? value : fn(value, field);
    } else if (Array.isArray(value)) {
      // The only array-valued fields are name lists (dates are objects).
      out[field] = value.map(mapName);
    } else {
      out[field] = value;
    }
  }
  return out as CslItem;
}

/** BibTeX entry keys are restricted to ASCII letters, digits and underscores. */
const SAFE_KEY = /^[A-Za-z0-9_]+$/;

/**
 * A deterministic, unique BibTeX key: `citation-key` or the id when it is already safe,
 * else the id with every other character replaced by `_` (`ar-thesis` → `ar_thesis`),
 * else `ref_<n>` for ids with no ASCII letter or digit.
 */
function bibtexKey(item: CslItem, index: number, used: Set<string>): string {
  const declared = [item['citation-key'], item.id].find(
    (value): value is string => value !== undefined && SAFE_KEY.test(value),
  );
  const sanitized = item.id.replace(/[^A-Za-z0-9_]/g, '_');
  const base = declared ?? (/[A-Za-z0-9]/.test(sanitized) ? sanitized : `ref_${index + 1}`);
  let key = base;
  for (let n = 2; used.has(key); n += 1) {
    key = `${base}_${n}`;
  }
  used.add(key);
  return key;
}

/**
 * The library writes a thesis whose genre is not literally "PhD thesis"/"Master's
 * thesis" (e.g. «رسالة دكتوراه») as `@misc`, which imports back as a generic document.
 * Such entries are written as `@phdthesis`/`@mastersthesis` with the genre kept in the
 * standard `type` field, which round-trips exactly.
 */
function thesisEntryType(item: CslItem): string | undefined {
  if (item.type !== 'thesis' || item.genre === undefined) {
    return undefined;
  }
  if (/^(?:(?:master'?s|diploma)|(?:phd|doctoral)) thesis$/i.test(item.genre)) {
    return undefined;
  }
  return /master|\u0645\u0627\u062C\u0633\u062A\u064A\u0631/i.test(item.genre)
    ? 'mastersthesis'
    : 'phdthesis';
}

/**
 * Exports items as BibTeX. Text is written as UTF-8 (Arabic is preserved, not
 * transliterated) with LaTeX special characters escaped; DOI and URL are verbatim.
 * Entry keys follow {@link bibtexKey}.
 */
export function toBibtex(items: readonly CslItemInput[]): string {
  const used = new Set<string>();
  const valid = validateItems(items);
  const prepared = valid.map((item, index) => ({
    ...mapStrings(item, (value) => escapeLatex(singleLine(value))),
    'citation-key': bibtexKey(item, index, used),
  }));
  let output = formatBibtexText(prepared);
  prepared.forEach((item, index) => {
    const original = valid[index];
    const entryType = original === undefined ? undefined : thesisEntryType(original);
    if (entryType !== undefined) {
      // Keys are unique ASCII identifiers, so this matches exactly one entry header.
      output = output.replace(
        `@misc{${item['citation-key']},`,
        `@${entryType}{${item['citation-key']},`,
      );
    }
  });
  return output;
}

/**
 * Exports items as RIS: one record per item, `TY` first and `ER` last, the item id in
 * `ID`, one tag per line (values are never wrapped), records separated by a newline.
 */
export function toRis(items: readonly CslItemInput[]): string {
  const valid = validateItems(items).map((item) => mapStrings(item, singleLine));
  return formatRisRecords(valid)
    .map((record) => [...record.map(([tag, value]) => `${tag}  - ${value}`), 'ER  - '].join('\n'))
    .map((record) => `${record}\n`)
    .join('');
}
