import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Extension } from '@tiptap/react';

/** One anchored review note to mark in the text. */
export interface ReviewRange {
  id: string;
  from: number;
  to: number;
  kind: 'comment' | 'suggestion';
}

const reviewKey = new PluginKey<DecorationSet>('reviewHighlights');

function decorations(state: EditorState, ranges: ReviewRange[]): DecorationSet {
  const size = state.doc.content.size;
  return DecorationSet.create(
    state.doc,
    ranges
      .filter((range) => range.from >= 0 && range.to <= size && range.from < range.to)
      .map((range) =>
        Decoration.inline(range.from, range.to, {
          class: `review-anchor${range.kind === 'suggestion' ? ' review-anchor-suggestion' : ''}`,
          'data-review-anchor': range.id,
        }),
      ),
  );
}

/**
 * Marks the ranges of open review notes. Decorations are view-only: they are not part of
 * the document, so they are never saved or exported. Edits move them along (mapping);
 * the editor replaces them whenever the list of notes changes.
 */
export const ReviewHighlights = Extension.create({
  name: 'reviewHighlights',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: reviewKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, current, _old, state) => {
            const ranges = tr.getMeta(reviewKey) as ReviewRange[] | undefined;
            if (ranges !== undefined) return decorations(state, ranges);
            return current.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations: (state) => reviewKey.getState(state),
        },
      }),
    ];
  },
});

/** A transaction that replaces the marked ranges (adds nothing to the document). */
export function setReviewRanges(tr: Transaction, ranges: ReviewRange[]): Transaction {
  return tr.setMeta(reviewKey, ranges).setMeta('addToHistory', false);
}
