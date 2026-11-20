/**
 * The only module that touches citation-js. Everything the libraries return is treated
 * as `unknown` and validated here, so no `any` reaches the rest of the package.
 *
 * Engine licensing note: `@citation-js/plugin-csl` (MIT) runs the citeproc-js engine,
 * which it depends on as the npm package `citeproc` (CPAL-1.0 OR AGPL-1.0). See
 * NOTICE.md and docs/adr/0008-citation-engine.md.
 */
import { readFileSync } from 'node:fs';

import * as core from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import '@citation-js/plugin-csl';
import '@citation-js/plugin-ris';
import { z } from 'zod';

import { CitationError } from './errors';
import type { CslItem } from './schema';
import type { CitationLocale, CitationStyle, OutputFormat } from './styles';

const { plugins } = core;

/** Styles rendered by citeproc-js, and the bundled CSL file for each. */
export type CslStyle = CitationStyle | 'chicago-notes';

const STYLE_FILES: Record<CslStyle, string> = {
  'apa-7': 'apa.csl',
  chicago: 'chicago-author-date.csl',
  mla: 'modern-language-association.csl',
  'chicago-notes': 'chicago-notes-bibliography.csl',
};

const LOCALE_FILES: Record<CitationLocale, { id: string; file: string }> = {
  ar: { id: 'ar', file: 'locales-ar.xml' },
  en: { id: 'en-US', file: 'locales-en-US.xml' },
};

/** Registered under a private prefix so the plugin's own bundled styles are never used. */
const styleKey = (style: CslStyle): string => `bahith-${style}`;

let registered = false;

/**
 * Registers the bundled styles and locales once. The `en-US` locale bundled inside
 * plugin-csl is replaced by the pinned copy so every term comes from one known version.
 */
function ensureRegistered(): void {
  if (registered) {
    return;
  }
  const csl = plugins.config.get('@csl');
  for (const [style, file] of Object.entries(STYLE_FILES)) {
    csl.styles.add(
      `bahith-${style}`,
      readFileSync(new URL(`../styles/${file}`, import.meta.url), 'utf8'),
    );
  }
  for (const { id, file } of Object.values(LOCALE_FILES)) {
    csl.locales.add(id, readFileSync(new URL(`../locales/${file}`, import.meta.url), 'utf8'));
  }
  registered = true;
}

/**
 * citation-js keeps every log message (including parser errors that quote the input) in
 * an in-memory array even when output is silenced. Research text must not linger in
 * process memory or reach logs, so the array is emptied after every call.
 */
function clearLibraryLog(): void {
  const logger: unknown = Reflect.get(core, 'logger');
  if (typeof logger !== 'object' || logger === null) {
    return;
  }
  Reflect.set(logger, 'level', 'silent');
  const entries: unknown = Reflect.get(logger, '_log');
  if (Array.isArray(entries)) {
    entries.length = 0;
  }
}

/** Runs `fn`, always clearing the library log afterwards. */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } finally {
    clearLibraryLog();
  }
}

// ---------------------------------------------------------------------------
// citeproc-js engine
// ---------------------------------------------------------------------------

export interface CiteprocCitation {
  citationID: string;
  citationItems: { id: string; locator?: string; label?: string }[];
  properties: { noteIndex: number };
}

interface CiteprocEngine {
  updateItems(ids: string[]): unknown;
  makeBibliography(): unknown;
  processCitationCluster(
    citation: CiteprocCitation,
    citationsPre: [string, number][],
    citationsPost: [string, number][],
    flag: number,
  ): unknown;
}

function isEngine(value: unknown): value is CiteprocEngine {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'updateItems') === 'function' &&
    typeof Reflect.get(value, 'makeBibliography') === 'function' &&
    typeof Reflect.get(value, 'processCitationCluster') === 'function'
  );
}

/** `CSL.ASSUME_ALL_ITEMS_REGISTERED`: items were registered up front by `updateItems`. */
const ASSUME_ALL_ITEMS_REGISTERED = 2;

const bibliographyResult = z.tuple([
  z.object({
    bibstart: z.string(),
    bibend: z.string(),
    entry_ids: z.array(z.array(z.union([z.string(), z.number()]))),
  }),
  z.array(z.string()),
]);

const clusterResult = z.tuple([
  z.unknown(),
  z.array(z.tuple([z.number().int().nonnegative(), z.string()]).rest(z.unknown())),
]);

function engineFor(
  items: readonly CslItem[],
  style: CslStyle,
  locale: CitationLocale,
  format: OutputFormat,
): CiteprocEngine {
  ensureRegistered();
  // The engine keeps references to the data it retrieves; give it a private copy.
  const data = structuredClone(items);
  const engine: unknown = plugins.config
    .get('@csl')
    .engine(data as unknown as core.CSL[], styleKey(style), LOCALE_FILES[locale].id, format);
  if (!isEngine(engine)) {
    throw new CitationError('CITATION_ENGINE_FAILED');
  }
  return engine;
}

export interface EngineBibliography {
  readonly bibstart: string;
  readonly bibend: string;
  readonly entries: readonly { readonly id: string; readonly output: string }[];
}

/** Renders the reference list for all `items`, in the style's sort order. */
export function cslBibliography(
  items: readonly CslItem[],
  style: CslStyle,
  locale: CitationLocale,
  format: OutputFormat,
): EngineBibliography {
  return guarded(() => {
    try {
      const engine = engineFor(items, style, locale, format);
      engine.updateItems(items.map((item) => item.id));
      const parsed = bibliographyResult.safeParse(engine.makeBibliography());
      if (!parsed.success) {
        throw new CitationError('CITATION_ENGINE_FAILED');
      }
      const [meta, outputs] = parsed.data;
      if (meta.entry_ids.length !== outputs.length) {
        throw new CitationError('CITATION_ENGINE_FAILED');
      }
      return {
        bibstart: meta.bibstart,
        bibend: meta.bibend,
        entries: outputs.map((output, index) => ({
          id: String(meta.entry_ids[index]?.[0] ?? ''),
          output,
        })),
      };
    } catch (error) {
      throw asEngineError(error);
    }
  });
}

/**
 * Renders citation clusters in document order. Every item in `items` is registered
 * first, so disambiguation (added initials, year suffixes such as 2020a/2020b) agrees
 * with the bibliography built from the same items.
 */
export function cslCitations(
  items: readonly CslItem[],
  citations: readonly CiteprocCitation[],
  style: CslStyle,
  locale: CitationLocale,
  format: OutputFormat,
): string[] {
  return guarded(() => {
    try {
      const engine = engineFor(items, style, locale, format);
      engine.updateItems(items.map((item) => item.id));
      const outputs: string[] = [];
      const pre: [string, number][] = [];
      for (const citation of citations) {
        const parsed = clusterResult.safeParse(
          engine.processCitationCluster(
            structuredClone(citation),
            [...pre],
            [],
            ASSUME_ALL_ITEMS_REGISTERED,
          ),
        );
        if (!parsed.success) {
          throw new CitationError('CITATION_ENGINE_FAILED');
        }
        pre.push([citation.citationID, citation.properties.noteIndex]);
        // The engine returns every citation whose rendering changed (e.g. a later
        // "Ibid." can change an earlier note); keep the latest text for each index.
        for (const [index, output] of parsed.data[1]) {
          outputs[index] = output;
        }
      }
      if (outputs.length !== citations.length || outputs.some((o) => typeof o !== 'string')) {
        throw new CitationError('CITATION_ENGINE_FAILED');
      }
      return outputs;
    } catch (error) {
      throw asEngineError(error);
    }
  });
}

function asEngineError(error: unknown): CitationError {
  return error instanceof CitationError ? error : new CitationError('CITATION_ENGINE_FAILED');
}

// ---------------------------------------------------------------------------
// BibTeX / RIS
// ---------------------------------------------------------------------------

export type InterchangeFormat = 'bibtex' | 'ris';

const INPUT_TYPES: Record<InterchangeFormat, string> = {
  bibtex: '@bibtex/text',
  ris: '@ris/file',
};

export interface ParseFailure {
  readonly line?: number;
  readonly column?: number;
}

/**
 * Parses BibTeX/RIS text into raw (unvalidated) CSL-JSON objects. Throws
 * `CITATION_PARSE_FAILED` carrying only the line/column the parser reported.
 */
export function parseInterchange(text: string, format: InterchangeFormat): unknown[] {
  return guarded(() => {
    let parsed: unknown;
    try {
      parsed = plugins.input.chain(text, {
        forceType: INPUT_TYPES[format],
        generateGraph: false,
        maxChainLength: 10,
        strict: true,
        target: '@csl/list+object',
      });
    } catch (error) {
      throw new CitationError('CITATION_PARSE_FAILED', parsePosition(error));
    }
    if (!Array.isArray(parsed)) {
      throw new CitationError('CITATION_PARSE_FAILED');
    }
    return Array.from<unknown>(parsed);
  });
}

/** Extracts "line N col M" from a parser message without keeping any of its text. */
function parsePosition(error: unknown): ParseFailure {
  const message = error instanceof Error ? error.message : '';
  const match = /\bline (\d{1,9}) col (\d{1,9})\b/.exec(message);
  if (!match?.[1] || !match[2]) {
    return {};
  }
  return { line: Number(match[1]), column: Number(match[2]) };
}

/** Formats validated items as BibTeX text. */
export function formatBibtexText(items: readonly CslItem[]): string {
  return guarded(() => {
    const data = structuredClone(items) as unknown as core.CSL[];
    const bibtexFormat = plugins.config.get('@bibtex').format;
    const previous = bibtexFormat.asciiOnly;
    try {
      // The default transliterates to ASCII and silently deletes Arabic. Unicode output
      // is valid for biber/BibLaTeX and UTF-8 BibTeX; LaTeX specials are escaped by the
      // caller (see interchange.ts).
      bibtexFormat.asciiOnly = false;
      const output: unknown = plugins.output.format('bibtex', data, { format: 'text' });
      if (typeof output !== 'string') {
        throw new CitationError('CITATION_EXPORT_FAILED');
      }
      return output;
    } catch (error) {
      throw error instanceof CitationError ? error : new CitationError('CITATION_EXPORT_FAILED');
    } finally {
      bibtexFormat.asciiOnly = previous;
    }
  });
}

const risValue = z.union([z.string(), z.number()]).transform(String);
const risRecords = z.array(
  z.record(z.string().regex(/^[A-Z][A-Z0-9]$/), z.union([risValue, z.array(risValue)])),
);

/** One RIS record: tag → values, in the library's tag order (`TY` first). */
export type RisRecord = readonly (readonly [tag: string, value: string])[];

/**
 * Maps validated items to RIS records. Serialisation is done by the caller because the
 * library's text output hard-wraps values every 70 characters, and its own parser
 * re-joins the pieces with a space, corrupting long titles on a round trip.
 */
export function formatRisRecords(items: readonly CslItem[]): RisRecord[] {
  return guarded(() => {
    const data = structuredClone(items) as unknown as core.CSL[];
    let output: unknown;
    try {
      output = plugins.output.format('ris', data, { format: 'object' });
    } catch {
      throw new CitationError('CITATION_EXPORT_FAILED');
    }
    const parsed = risRecords.safeParse(output);
    if (!parsed.success) {
      throw new CitationError('CITATION_EXPORT_FAILED');
    }
    return parsed.data.map((record) => {
      const lines: [string, string][] = [];
      for (const [tag, value] of Object.entries(record)) {
        for (const single of Array.isArray(value) ? value : [value]) {
          lines.push([tag, single]);
        }
      }
      const type = lines.filter(([tag]) => tag === 'TY');
      return [...type, ...lines.filter(([tag]) => tag !== 'TY' && tag !== 'ER')];
    });
  });
}
