/** A span of a stored passage in Unicode code points (end exclusive), with its text. */
export interface PassageSpan {
  charStart: number;
  charEnd: number;
  quote: string;
}

/** The whole passage as a span. */
export function wholePassage(content: string): PassageSpan {
  return { charStart: 0, charEnd: Array.from(content).length, quote: content };
}

/**
 * The span a browser selection covers, from its UTF-16 start offset within the passage
 * text and the selected text. Surrounding whitespace is dropped. The result is in code
 * points, which is what the server counts (an astral character is one code point but two
 * UTF-16 units). Returns null when the selection is blank or does not match the passage
 * at that offset; the server verifies the quote again either way.
 */
export function selectionSpan(
  content: string,
  utf16Start: number,
  selected: string,
): PassageSpan | null {
  const quote = selected.trim();
  if (quote === '') return null;
  const start = utf16Start + (selected.length - selected.trimStart().length);
  if (start < 0 || content.slice(start, start + quote.length) !== quote) return null;
  const charStart = Array.from(content.slice(0, start)).length;
  return { charStart, charEnd: charStart + Array.from(quote).length, quote };
}
