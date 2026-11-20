import ar from './messages/ar.json';
import en from './messages/en.json';
import type { Block, Direction, ExportDocument, HeadingBlock, Inline, Language } from './model';

export type Labels = typeof ar;
export type LabelKey = keyof Labels;

const MESSAGES: Record<Language, Labels> = { ar, en };

/** Interface strings for generated parts of a document (TOC title, notes heading, …). */
export function label(
  language: Language,
  key: LabelKey,
  params: Record<string, string> = {},
): string {
  return MESSAGES[language][key].replace(
    /\{(\w+)\}/gu,
    (whole, name: string) => params[name] ?? whole,
  );
}

/** Strong right-to-left letters: Hebrew, Arabic, Syriac, Thaana, NKo, … and presentation forms. */
const RTL_STRONG = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/u;
const LETTER = /\p{L}/u;

type Strength = 'rtl' | 'ltr' | 'neutral';

function strength(char: string): Strength {
  if (RTL_STRONG.test(char)) return 'rtl';
  if (LETTER.test(char)) return 'ltr';
  return 'neutral';
}

export interface DirectionalSegment {
  text: string;
  rtl: boolean;
}

/**
 * Splits text into runs of one script direction, so a DOCX run can carry `w:rtl`
 * only where it contains right-to-left letters. Neutral characters (spaces,
 * punctuation, digits) join their neighbours, following the paragraph's base
 * direction when they sit between runs of different directions (as the Unicode
 * bidi algorithm resolves them). Text is never altered: segments concatenate
 * back to the input exactly.
 */
export function splitByDirection(text: string, base: Direction): DirectionalSegment[] {
  const segments: DirectionalSegment[] = [];
  let current: DirectionalSegment | undefined;
  let pending = '';

  for (const char of text) {
    const kind = strength(char);
    if (kind === 'neutral') {
      pending += char;
      continue;
    }
    const rtl = kind === 'rtl';
    if (current === undefined) {
      current = { text: pending + char, rtl };
      segments.push(current);
    } else if (current.rtl === rtl) {
      current.text += pending + char;
    } else {
      const baseRtl = base === 'rtl';
      if (current.rtl === baseRtl) {
        current.text += pending;
        current = { text: char, rtl };
      } else {
        current = { text: pending + char, rtl };
      }
      segments.push(current);
    }
    pending = '';
  }
  if (current === undefined) {
    return text.length === 0 ? [] : [{ text, rtl: base === 'rtl' }];
  }
  current.text += pending;
  return segments;
}

/** Like HTML `dir="auto"`: the direction of the first strong letter, else `fallback`. */
export function autoDirection(text: string, fallback: Direction): Direction {
  for (const char of text) {
    const kind = strength(char);
    if (kind !== 'neutral') return kind;
  }
  return fallback;
}

/** The direction a block is laid out in: its own `dir`, else the document's. */
export function blockDirection(block: Block, doc: ExportDocument): Direction {
  return ('dir' in block ? block.dir : undefined) ?? doc.meta.direction;
}

export interface HeadingEntry {
  /** Stable anchor id, also used for bookmarks and HTML ids. */
  id: string;
  block: HeadingBlock;
}

/** Headings in document order with stable anchors (`h-1`, `h-2`, …). */
export function collectHeadings(doc: ExportDocument): HeadingEntry[] {
  const headings: HeadingEntry[] = [];
  for (const block of doc.body) {
    if (block.type === 'heading') headings.push({ id: `h-${headings.length + 1}`, block });
  }
  return headings;
}

/** Number of footnotes in the body, counted the way every exporter numbers them. */
export function countFootnotes(doc: ExportDocument): number {
  const inRuns = (runs: readonly Inline[]) => runs.filter((run) => run.type === 'footnote').length;
  let count = 0;
  for (const block of doc.body) {
    if (block.type === 'paragraph' || block.type === 'blockquote') count += inRuns(block.runs);
    if (block.type === 'list') for (const item of block.items) count += inRuns(item);
  }
  return count;
}

export function countImages(doc: ExportDocument): number {
  return doc.body.filter((block) => block.type === 'image').length;
}
