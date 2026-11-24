import { describe, expect, it } from 'vitest';

import { codePointSlice } from '@bahith/db';

import { selectionSpan, wholePassage } from '@/lib/highlight-span';

const PASSAGE = 'الْإِحْصَاءُ الوصفي 𝔸 في دراسة ميدانية';

describe('highlight spans', () => {
  it('the whole passage is every code point', () => {
    const span = wholePassage(PASSAGE);
    expect(span.charEnd).toBe(Array.from(PASSAGE).length);
    expect(span.charEnd).toBe(PASSAGE.length - 1); // one astral character
    expect(codePointSlice(PASSAGE, span.charStart, span.charEnd)).toBe(PASSAGE);
  });

  it('converts a UTF-16 selection to code points the server accepts', () => {
    const selected = ' دراسة ';
    const utf16 = PASSAGE.indexOf(selected);
    const span = selectionSpan(PASSAGE, utf16, selected);
    expect(span?.quote).toBe('دراسة');
    // The quote starts one UTF-16 unit after the selection (the leading space is dropped);
    // after the astral character, code points are one fewer than UTF-16 units.
    const quoteUtf16 = utf16 + 1;
    expect(span?.charStart).toBe(quoteUtf16 - 1);
    expect(span && codePointSlice(PASSAGE, span.charStart, span.charEnd)).toBe('دراسة');
  });

  it('keeps diacritics exactly as stored', () => {
    const span = selectionSpan(PASSAGE, 0, 'الْإِحْصَاءُ');
    expect(span).toEqual({ charStart: 0, charEnd: 12, quote: 'الْإِحْصَاءُ' });
  });

  it('refuses blank selections and text that is not at the offset', () => {
    expect(selectionSpan(PASSAGE, 3, '   ')).toBeNull();
    expect(selectionSpan(PASSAGE, 0, 'الإحصاء')).toBeNull();
    expect(selectionSpan(PASSAGE, 5, 'الوصفي')).toBeNull();
    expect(selectionSpan(PASSAGE, -1, 'ا')).toBeNull();
  });
});
