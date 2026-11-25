import { mergeAttributes, Node } from '@tiptap/react';

/**
 * In-text citation of a SANAD passage. `label` and `page` are for display and for
 * opening the source only: when the draft is exported, the citation text and page are
 * rebuilt by the citation engine from the stored source and passage (never from here).
 */
export const Citation = Node.create({
  name: 'citation',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      sourceId: { default: null },
      chunkId: { default: null },
      fileId: { default: null },
      page: { default: null },
      label: { default: '' },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-citation]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const label = typeof node.attrs.label === 'string' ? node.attrs.label : '';
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-citation': '',
        class: 'citation-chip',
        contenteditable: 'false',
        dir: 'auto',
      }),
      label,
    ];
  },
  renderText({ node }) {
    return typeof node.attrs.label === 'string' ? node.attrs.label : '';
  },
});

/** A footnote; its number is drawn by CSS counters, its text exported as a real note. */
export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { text: { default: '' } };
  },
  parseHTML() {
    return [{ tag: 'sup[data-footnote]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const text = typeof node.attrs.text === 'string' ? node.attrs.text : '';
    return [
      'sup',
      mergeAttributes(HTMLAttributes, {
        'data-footnote': '',
        class: 'footnote-ref',
        title: text,
        contenteditable: 'false',
      }),
    ];
  },
});
