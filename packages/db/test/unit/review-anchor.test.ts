import { describe, expect, it } from 'vitest';

import {
  ATOM_CHAR,
  commentAnchorSchema,
  inlineBlocks,
  locateQuote,
  MAX_ANCHOR_DRIFT,
  replaceRange,
  replacementSchema,
  textAt,
} from '../../src/review-anchor';

const text = (value: string, marks?: { type: string }[]) =>
  marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
const paragraph = (...content: Record<string, unknown>[]) => ({ type: 'paragraph', content });

/*
 * Positions as ProseMirror counts them:
 *   0 <h1> 1 "الفصل" 6 </h1> 7 <p> 8 "منهج " 13 [citation] 14 " الدراسة" 22 </p> 23
 *   <ul> 24 <li> 25 <p> 26 "بند" 29 </p> 30 </li> 31 </ul> 32
 */
const citation = { type: 'citation', attrs: { sourceId: 's', label: '[x]' } };
const doc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [text('الفصل')] },
    paragraph(text('منهج '), citation, text(' الدراسة')),
    { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('بند'))] }] },
  ],
};

describe('inlineBlocks', () => {
  it('counts positions like ProseMirror, with atoms as one position', () => {
    expect(inlineBlocks(doc)).toEqual([
      { path: [0], start: 1, text: 'الفصل' },
      { path: [1], start: 8, text: `منهج ${ATOM_CHAR} الدراسة` },
      { path: [2, 0, 0], start: 26, text: 'بند' },
    ]);
  });

  it('counts empty paragraphs and horizontal rules', () => {
    const blocks = inlineBlocks({
      type: 'doc',
      content: [{ type: 'paragraph' }, { type: 'horizontalRule' }, paragraph(text('بعد'))],
    });
    // <p></p> = 2, <hr> = 1, so the third block's content starts at 4.
    expect(blocks.map((block) => block.start)).toEqual([1, 4]);
  });
});

describe('textAt', () => {
  it('returns a text-only range inside one block', () => {
    expect(textAt(doc, 15, 22)).toBe('الدراسة');
    expect(textAt(doc, 26, 29)).toBe('بند');
  });

  it('refuses ranges that cross a citation or a block boundary', () => {
    expect(textAt(doc, 10, 16)).toBeNull();
    expect(textAt(doc, 4, 10)).toBeNull();
    expect(textAt(doc, 5, 5)).toBeNull();
  });
});

describe('locateQuote', () => {
  const anchor = { from: 15, to: 22, quote: 'الدراسة' };

  it('on the same version, accepts only the exact range', () => {
    expect(locateQuote(doc, anchor, true)).toEqual({ from: 15, to: 22 });
    expect(locateQuote(doc, { ...anchor, from: 14, to: 21 }, true)).toBeNull();
  });

  it('in a later version, follows the quote when it moved and is unique', () => {
    const later = { ...doc, content: [paragraph(text('تمهيد جديد')), ...doc.content] };
    expect(locateQuote(later, anchor, false)).toEqual({ from: 27, to: 34 });
  });

  it('is stale when the quote is gone, ambiguous, or too far away', () => {
    const gone = { type: 'doc', content: [paragraph(text('نص آخر'))] };
    expect(locateQuote(gone, anchor, false)).toBeNull();
    const twice = {
      type: 'doc',
      content: [paragraph(text('الدراسة الأولى والدراسة الثانية'))],
    };
    expect(locateQuote(twice, { from: 1, to: 8, quote: 'الدراسة' }, false)).toBeNull();
    const far = {
      type: 'doc',
      content: [paragraph(text('أ'.repeat(MAX_ANCHOR_DRIFT + 100))), paragraph(text('الدراسة'))],
    };
    expect(locateQuote(far, anchor, false)).toBeNull();
  });
});

describe('replaceRange', () => {
  it('replaces the text, keeps the citation and does not touch the input', () => {
    const before = JSON.stringify(doc);
    const next = replaceRange(doc, 15, 22, 'البحث');
    expect(JSON.stringify(doc)).toBe(before);
    expect(next.content).toEqual([
      doc.content[0],
      paragraph(text('منهج '), citation, text(' البحث')),
      doc.content[2],
    ]);
  });

  it('replaces across differently formatted text with the first formatting', () => {
    const bold = [{ type: 'bold' }];
    const source = {
      type: 'doc',
      content: [paragraph(text('نتائج '), text('مهمة', bold), text(' جدا'))],
    };
    // "نتائج " = 1..7, "مهمة" = 7..11, " جدا" = 11..15.
    expect(replaceRange(source, 7, 12, 'بالغة').content).toEqual([
      paragraph(text('نتائج '), text('بالغة', bold), text('جدا')),
    ]);
    // Starting in plain text: the replacement is plain and joins its neighbours.
    expect(replaceRange(source, 5, 12, 'X').content).toEqual([paragraph(text('نتائXجدا'))]);
  });

  it('deletes the quote when the replacement is empty, and merges equal neighbours', () => {
    const source = { type: 'doc', content: [paragraph(text('أ ب ج'))] };
    expect(replaceRange(source, 2, 4, '')).toEqual({
      type: 'doc',
      content: [paragraph(text('أ ج'))],
    });
    const whole = replaceRange(source, 1, 6, '');
    expect(whole).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });

  it('throws for a range that is not plain text in one block', () => {
    expect(() => replaceRange(doc, 10, 16, 'x')).toThrow(RangeError);
  });
});

describe('schemas', () => {
  it('requires the range length to equal the quote length', () => {
    expect(
      commentAnchorSchema.safeParse({ versionNumber: 1, from: 1, to: 4, quote: 'abc' }).success,
    ).toBe(true);
    expect(
      commentAnchorSchema.safeParse({ versionNumber: 1, from: 1, to: 5, quote: 'abc' }).success,
    ).toBe(false);
    expect(
      commentAnchorSchema.safeParse({ versionNumber: 0, from: 1, to: 4, quote: 'abc' }).success,
    ).toBe(false);
    expect(
      commentAnchorSchema.safeParse({ versionNumber: 1, from: 1, to: 2, quote: ATOM_CHAR }).success,
    ).toBe(false);
  });

  it('keeps a replacement inside one paragraph', () => {
    expect(replacementSchema.safeParse('نص بديل').success).toBe(true);
    expect(replacementSchema.safeParse('').success).toBe(true);
    expect(replacementSchema.safeParse('سطر\nآخر').success).toBe(false);
  });
});
