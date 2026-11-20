import { describe, expect, it } from 'vitest';

import { buildFilename, parseLatexMath, splitByDirection, toMathML } from '../src';
import { sniffSize } from '../src/image';
import { PNG_4X3, TASHKEEL } from './fixtures';

describe('splitByDirection', () => {
  it('returns one RTL segment for Arabic with tashkeel, unchanged', () => {
    expect(splitByDirection(TASHKEEL, 'rtl')).toEqual([{ text: TASHKEEL, rtl: true }]);
  });

  it('splits mixed text; neutrals between scripts follow the base direction', () => {
    expect(splitByDirection('يرى Smith (2020) أن', 'rtl')).toEqual([
      { text: 'يرى ', rtl: true },
      { text: 'Smith', rtl: false },
      { text: ' (2020) أن', rtl: true },
    ]);
    expect(splitByDirection('see الباحث (2020) here', 'ltr')).toEqual([
      { text: 'see ', rtl: false },
      { text: 'الباحث', rtl: true },
      { text: ' (2020) here', rtl: false },
    ]);
  });

  it('gives neutral-only text the base direction and never loses characters', () => {
    expect(splitByDirection('(١٥) ،', 'rtl')).toEqual([{ text: '(١٥) ،', rtl: true }]);
    expect(splitByDirection('', 'rtl')).toEqual([]);
    const mixed = ' ١. Word كلمة 3.5% —x';
    expect(
      splitByDirection(mixed, 'ltr')
        .map((segment) => segment.text)
        .join(''),
    ).toBe(mixed);
  });
});

describe('LaTeX math subset', () => {
  it('parses fractions, roots, scripts, Greek letters and operators', () => {
    const nodes = parseLatexMath('\\sqrt[3]{x_i^2} \\leq \\frac{\\alpha}{2} \\cdot n');
    expect(nodes).toBeDefined();
    expect(toMathML(nodes ?? [], 'src')).toBe(
      '<math display="block" alttext="src"><mrow><mroot><msubsup><mi>x</mi><mi>i</mi><mn>2</mn></msubsup><mn>3</mn></mroot><mo>≤</mo><mfrac><mi>α</mi><mn>2</mn></mfrac><mo>·</mo><mi>n</mi></mrow></math>',
    );
  });

  it('returns undefined outside the subset instead of guessing', () => {
    for (const latex of [
      '\\begin{matrix} a & b \\end{matrix}',
      '\\left( x \\right)',
      '\\mathbb{R}',
      'x^',
      '{x',
      'x}',
      'x^a^b',
      'a \\\\ b',
    ]) {
      expect(parseLatexMath(latex)).toBeUndefined();
    }
  });

  it('escapes text in MathML', () => {
    const nodes = parseLatexMath('a < b');
    expect(toMathML(nodes ?? [], 'a < b')).toBe(
      '<math display="block" alttext="a &lt; b"><mrow><mi>a</mi><mo>&lt;</mo><mi>b</mi></mrow></math>',
    );
  });
});

describe('helpers', () => {
  it('builds filesystem-safe filenames that keep Arabic letters', () => {
    expect(buildFilename('أثرُ التعلّم: دراسة/تجريبية؟', 'docx')).toBe(
      'أثر-التعلم-دراسة-تجريبية.docx',
    );
    expect(buildFilename('...', 'pdf')).toBe('document.pdf');
  });

  it('reads PNG dimensions from the header', () => {
    expect(sniffSize(PNG_4X3)).toEqual({ width: 4, height: 3 });
    expect(sniffSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});
