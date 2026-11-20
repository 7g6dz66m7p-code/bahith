/**
 * Deterministic formatting of references, in-text citations and notes.
 *
 * A language model never writes a reference (engineering rule 9): every string here is
 * produced by the bundled CSL styles running in citeproc-js, or by the in-house
 * `arabic-traditional` formatter, from validated CSL-JSON built out of verified
 * `sources` rows.
 */
import {
  arabicTraditionalBibliography,
  arabicTraditionalNotes,
  escapeHtml,
} from './arabic-traditional';
import { CitationError } from './errors';
import {
  clusterSchema,
  formatOptionsSchema,
  LIMITS,
  parseOrThrow,
  validateItems,
  type CitationCluster,
  type CslItem,
  type CslItemInput,
  type FormatOptions,
  type LocatorLabel,
  type ResolvedCluster,
  type ResolvedFormatOptions,
} from './schema';
import { isNoteStyle } from './styles';
import { cslBibliography, cslCitations, type CiteprocCitation, type CslStyle } from './vendor';

export interface BibliographyEntry {
  /** The CSL item id the entry was built from. */
  readonly id: string;
  /** One rendered reference (no trailing newline). */
  readonly output: string;
}

export interface FormattedBibliography {
  /** Entries in the style's sort order. */
  readonly entries: readonly BibliographyEntry[];
  /**
   * The whole list. `text`: entries separated by "\n". `html`: a
   * `<div class="csl-bib-body">` with one `<div class="csl-entry" dir="auto">` per entry.
   */
  readonly output: string;
}

interface ResolvedCite {
  readonly item: CslItem;
  readonly locator?: string;
  readonly label?: LocatorLabel;
}

function resolveOptions(options: FormatOptions): ResolvedFormatOptions {
  return parseOrThrow(formatOptionsSchema, options, ['options']);
}

/** Validates clusters and resolves every cited id against `items`. */
function resolveClusters(
  clusters: readonly CitationCluster[],
  byId: ReadonlyMap<string, CslItem>,
): ResolvedCite[][] {
  if (clusters.length > LIMITS.clusters) {
    throw new CitationError('CITATION_INVALID_INPUT', {
      issues: [{ path: ['clusters'], code: 'too_big' }],
    });
  }
  return clusters.map((input, clusterIndex) => {
    const cluster: ResolvedCluster = parseOrThrow(clusterSchema, input, ['clusters', clusterIndex]);
    if (new Set(cluster.itemIds).size !== cluster.itemIds.length) {
      throw new CitationError('CITATION_INVALID_INPUT', {
        index: clusterIndex,
        issues: [{ path: ['clusters', clusterIndex, 'itemIds'], code: 'duplicate' }],
      });
    }
    const locators = new Map<string, { locator: string; label: LocatorLabel }>();
    for (const [locatorIndex, entry] of (cluster.locators ?? []).entries()) {
      if (!cluster.itemIds.includes(entry.id) || locators.has(entry.id)) {
        throw new CitationError('CITATION_INVALID_INPUT', {
          index: clusterIndex,
          issues: [
            { path: ['clusters', clusterIndex, 'locators', locatorIndex, 'id'], code: 'invalid' },
          ],
        });
      }
      locators.set(entry.id, { locator: entry.locator, label: entry.label });
    }
    return cluster.itemIds.map((id) => {
      const item = byId.get(id);
      if (item === undefined) {
        throw new CitationError('CITATION_UNKNOWN_ITEM', { index: clusterIndex });
      }
      const pin = locators.get(id);
      return pin === undefined ? { item } : { item, locator: pin.locator, label: pin.label };
    });
  });
}

function toCiteproc(clusters: readonly ResolvedCite[][], notes: boolean): CiteprocCitation[] {
  return clusters.map((cites, index) => ({
    citationID: `bahith-c${index + 1}`,
    citationItems: cites.map((cite) =>
      cite.locator === undefined
        ? { id: cite.item.id }
        : { id: cite.item.id, locator: cite.locator, label: cite.label ?? 'page' },
    ),
    properties: { noteIndex: notes ? index + 1 : 0 },
  }));
}

function indexItems(items: readonly CslItem[]): Map<string, CslItem> {
  return new Map(items.map((item) => [item.id, item]));
}

/** Adds the item id and `dir="auto"` to each citeproc HTML entry (mixed RTL/LTR lists). */
function decorateHtmlEntry(entry: BibliographyEntry): BibliographyEntry {
  const output = entry.output.trim();
  const open = '<div class="csl-entry">';
  if (!output.startsWith(open)) {
    throw new CitationError('CITATION_ENGINE_FAILED');
  }
  return {
    id: entry.id,
    output: `<div class="csl-entry" data-csl-entry-id="${escapeHtml(entry.id)}" dir="auto">${output.slice(open.length)}`,
  };
}

/**
 * Renders the reference list for `items` in the requested style and locale. Every item
 * passed appears exactly once; ids must be unique.
 */
export function formatBibliography(
  items: readonly CslItemInput[],
  options: FormatOptions,
): FormattedBibliography {
  const { style, locale, format } = resolveOptions(options);
  const valid = validateItems(items);
  if (valid.length === 0) {
    return { entries: [], output: format === 'html' ? '<div class="csl-bib-body"></div>' : '' };
  }

  if (style === 'arabic-traditional') {
    const entries = arabicTraditionalBibliography(valid, format).map((entry) =>
      format === 'html'
        ? {
            id: entry.id,
            output: `<div class="csl-entry" data-csl-entry-id="${escapeHtml(entry.id)}" dir="auto">${entry.output}</div>`,
          }
        : entry,
    );
    return { entries, output: joinBibliography(entries, format) };
  }

  const result = cslBibliography(valid, style, locale, format);
  const entries = result.entries.map((entry) =>
    format === 'html' ? decorateHtmlEntry(entry) : { id: entry.id, output: entry.output.trim() },
  );
  if (entries.length !== valid.length || new Set(entries.map((e) => e.id)).size !== valid.length) {
    throw new CitationError('CITATION_ENGINE_FAILED');
  }
  return { entries, output: joinBibliography(entries, format) };
}

function joinBibliography(entries: readonly BibliographyEntry[], format: 'text' | 'html'): string {
  if (format === 'text') {
    return entries.map((entry) => entry.output).join('\n');
  }
  return `<div class="csl-bib-body">\n${entries.map((entry) => `  ${entry.output}\n`).join('')}</div>`;
}

/**
 * Renders one in-text citation, e.g. APA "(LeCun et al., 2015, p. 437)". `items` is
 * the full reference list of the document, so disambiguation matches the bibliography.
 * With a note style (`chicago-notes`, `arabic-traditional`) the result is the text of a
 * first-reference note; use {@link formatNotes} for a sequence of notes.
 */
export function formatCitation(
  cluster: CitationCluster,
  items: readonly CslItemInput[],
  options: FormatOptions,
): string {
  const [output] = formatClusters([cluster], items, options, false);
  if (output === undefined) {
    throw new CitationError('CITATION_ENGINE_FAILED');
  }
  return output;
}

/**
 * Renders the footnotes of a document in order. Note styles shorten repeated
 * citations (Chicago short notes, «المرجع نفسه» in `arabic-traditional`), so the
 * sequence matters: pass every note of the document, first to last.
 */
export function formatNotes(
  clusters: readonly CitationCluster[],
  items: readonly CslItemInput[],
  options: FormatOptions,
): string[] {
  return formatClusters(clusters, items, options, true);
}

/**
 * Renders a single footnote. `precedingNotes` are the notes before it in the document
 * (needed for short forms and «المرجع نفسه»); omit them for a first-reference note.
 */
export function formatNote(
  cluster: CitationCluster,
  items: readonly CslItemInput[],
  options: FormatOptions & { precedingNotes?: readonly CitationCluster[] },
): string {
  const { precedingNotes = [], ...formatOptions } = options;
  const outputs = formatClusters([...precedingNotes, cluster], items, formatOptions, true);
  const output = outputs[outputs.length - 1];
  if (output === undefined) {
    throw new CitationError('CITATION_ENGINE_FAILED');
  }
  return output;
}

function formatClusters(
  clusters: readonly CitationCluster[],
  items: readonly CslItemInput[],
  options: FormatOptions,
  notes: boolean,
): string[] {
  const { style, locale, format } = resolveOptions(options);
  if (notes && !isNoteStyle(style)) {
    throw new CitationError('CITATION_NOT_NOTE_STYLE');
  }
  const valid = validateItems(items);
  const resolved = resolveClusters(clusters, indexItems(valid));
  if (resolved.length === 0) {
    return [];
  }
  if (style === 'arabic-traditional') {
    // Every cluster is a note in this style; a lone in-text call is a first-reference note.
    return arabicTraditionalNotes(resolved, format);
  }
  const cslStyle: CslStyle = style;
  return cslCitations(
    valid,
    toCiteproc(resolved, notes || cslStyle === 'chicago-notes'),
    cslStyle,
    locale,
    format,
  );
}
