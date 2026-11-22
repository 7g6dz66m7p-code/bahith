import { z } from 'zod';

/**
 * Review anchors over ProseMirror / Tiptap JSON, without a ProseMirror runtime: the server
 * checks and applies suggestions with exactly the logic the editor uses to highlight them.
 * Pure (no database), so the browser bundle can import it.
 *
 * Positions follow ProseMirror: a text node counts its UTF-16 length, an inline atom
 * (citation, footnote, hard break) counts 1, and every other node counts 2 (open + close)
 * plus its content. An anchor is a text-only range inside one text block, so its length
 * equals the quote's length and it never cuts through a citation or a footnote.
 */

/** Stands for an inline atom in a text block's inline string; never part of a quote. */
export const ATOM_CHAR = '￼';

/** How far (in positions) a quote may move from its anchor and still be found. */
export const MAX_ANCHOR_DRIFT = 5_000;

export const MAX_QUOTE_LENGTH = 5_000;

const TEXTBLOCK_TYPES = new Set(['paragraph', 'heading', 'codeBlock']);
const BLOCK_LEAF_TYPES = new Set(['horizontalRule', 'image']);

const noAtom = (value: string) => !value.includes(ATOM_CHAR);

export const commentAnchorSchema = z
  .strictObject({
    versionNumber: z.number().int().min(1),
    from: z.number().int().min(0),
    to: z.number().int().min(1),
    quote: z.string().min(1).max(MAX_QUOTE_LENGTH).refine(noAtom),
  })
  .refine((anchor) => anchor.to - anchor.from === anchor.quote.length);

export type CommentAnchorInput = z.infer<typeof commentAnchorSchema>;

/** A suggested replacement: one paragraph of text (may be empty, to delete the quote). */
export const replacementSchema = z
  .string()
  .max(MAX_QUOTE_LENGTH)
  .refine((value) => noAtom(value) && !/[\r\n]/u.test(value));

interface JsonNode {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  marks?: unknown;
}

const asNode = (value: unknown): JsonNode =>
  typeof value === 'object' && value !== null ? value : {};

const childrenOf = (node: JsonNode): unknown[] => (Array.isArray(node.content) ? node.content : []);

const isText = (node: JsonNode): boolean => node.type === 'text' && typeof node.text === 'string';

const isTextblock = (node: JsonNode): boolean =>
  typeof node.type === 'string' && TEXTBLOCK_TYPES.has(node.type);

/** One text block: where its content starts, and its inline string (atoms as ATOM_CHAR). */
export interface InlineBlock {
  /** Index path from the doc's content down to the text block. */
  path: number[];
  start: number;
  text: string;
}

function inlineText(block: JsonNode): string {
  return childrenOf(block)
    .map((child) => {
      const node = asNode(child);
      return isText(node) ? (node.text as string) : ATOM_CHAR;
    })
    .join('');
}

function nodeSize(node: JsonNode): number {
  if (isText(node)) return (node.text as string).length;
  if (isTextblock(node)) return 2 + inlineText(node).length;
  if (typeof node.type === 'string' && BLOCK_LEAF_TYPES.has(node.type)) return 1;
  return 2 + childrenOf(node).reduce<number>((sum, child) => sum + nodeSize(asNode(child)), 0);
}

/** Every text block of a document, in document order. */
export function inlineBlocks(doc: unknown): InlineBlock[] {
  const blocks: InlineBlock[] = [];
  const walk = (parent: JsonNode, contentStart: number, path: number[]) => {
    let pos = contentStart;
    childrenOf(parent).forEach((child, index) => {
      const node = asNode(child);
      if (isTextblock(node)) {
        blocks.push({ path: [...path, index], start: pos + 1, text: inlineText(node) });
      } else if (!isText(node)) {
        walk(node, pos + 1, [...path, index]);
      }
      pos += nodeSize(node);
    });
  };
  walk(asNode(doc), 0, []);
  return blocks;
}

/** The text of a text-only range inside one text block, or null. */
export function textAt(doc: unknown, from: number, to: number): string | null {
  if (to <= from) return null;
  for (const block of inlineBlocks(doc)) {
    if (from >= block.start && to <= block.start + block.text.length) {
      const text = block.text.slice(from - block.start, to - block.start);
      return noAtom(text) ? text : null;
    }
  }
  return null;
}

/**
 * Finds the anchored quote in `doc`. When `doc` is the very version the anchor was made
 * on, only the exact range counts. In a later version positions may have moved, so the
 * quote is accepted only where it occurs exactly once within MAX_ANCHOR_DRIFT of the
 * anchor: two candidates, or none, mean the anchor is stale. It is never guessed.
 */
export function locateQuote(
  doc: unknown,
  anchor: Pick<CommentAnchorInput, 'from' | 'to' | 'quote'>,
  sameVersion: boolean,
): { from: number; to: number } | null {
  if (sameVersion) {
    return textAt(doc, anchor.from, anchor.to) === anchor.quote
      ? { from: anchor.from, to: anchor.to }
      : null;
  }
  const candidates: number[] = [];
  for (const block of inlineBlocks(doc)) {
    for (
      let offset = block.text.indexOf(anchor.quote);
      offset !== -1;
      offset = block.text.indexOf(anchor.quote, offset + 1)
    ) {
      const from = block.start + offset;
      if (Math.abs(from - anchor.from) <= MAX_ANCHOR_DRIFT) candidates.push(from);
      if (candidates.length > 1) return null;
    }
  }
  const [from] = candidates;
  return from === undefined ? null : { from, to: from + anchor.quote.length };
}

const sameMarks = (a: JsonNode, b: JsonNode) =>
  JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? []);

/**
 * Returns a copy of `doc` with the text-only range [from, to) replaced by `replacement`,
 * which takes the formatting (marks) of the first replaced character. Throws when the
 * range is not text inside a single text block (callers locate it with locateQuote).
 */
export function replaceRange(
  doc: Record<string, unknown>,
  from: number,
  to: number,
  replacement: string,
): Record<string, unknown> {
  const copy = structuredClone(doc);
  const block = inlineBlocks(copy).find(
    (candidate) => from >= candidate.start && to <= candidate.start + candidate.text.length,
  );
  if (block === undefined || textAt(copy, from, to) === null) {
    throw new RangeError('The range is not text inside one text block.');
  }
  let target = asNode(copy);
  for (const index of block.path) target = asNode(childrenOf(target)[index]);

  const relFrom = from - block.start;
  const relTo = to - block.start;
  const out: JsonNode[] = [];
  let offset = 0;
  let inserted = false;
  for (const child of childrenOf(target)) {
    const node = asNode(child);
    const size = isText(node) ? (node.text as string).length : 1;
    const start = offset;
    const end = offset + size;
    offset = end;
    if (!isText(node) || end <= relFrom || start >= relTo) {
      out.push(node);
      continue;
    }
    const text = node.text as string;
    const before = text.slice(0, Math.max(0, relFrom - start));
    const after = text.slice(Math.min(size, relTo - start));
    if (before !== '') out.push({ ...node, text: before });
    if (!inserted && replacement !== '') out.push({ ...node, text: replacement });
    inserted = true;
    if (after !== '') out.push({ ...node, text: after });
  }
  // Adjacent text with the same marks becomes one node, as ProseMirror stores it.
  const merged: JsonNode[] = [];
  for (const node of out) {
    const last = merged.at(-1);
    if (last !== undefined && isText(last) && isText(node) && sameMarks(last, node)) {
      merged[merged.length - 1] = { ...last, text: `${last.text as string}${node.text as string}` };
    } else {
      merged.push(node);
    }
  }
  const mutable = target as Record<string, unknown>;
  if (merged.length === 0) delete mutable.content;
  else mutable.content = merged;
  return copy;
}
