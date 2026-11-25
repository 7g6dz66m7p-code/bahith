/**
 * A deliberately small LaTeX math parser: enough for the inline formulas common in
 * theses (fractions, roots, scripts, Greek letters, relations), converted to OMML for
 * DOCX and MathML for HTML/PDF. Anything outside the subset (environments, `\left`,
 * matrices, unknown commands, alignment `&`) returns `undefined` so exporters fall back
 * to text with an `EQUATION_AS_TEXT` warning, instead of producing wrong math.
 */

export type MathNode =
  | { kind: 'ident'; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'op'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'frac'; num: MathNode[]; den: MathNode[] }
  | { kind: 'sqrt'; body: MathNode[]; index?: MathNode[] }
  | { kind: 'scripts'; base: MathNode[]; sub?: MathNode[]; sup?: MathNode[] };

const GREEK: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
};

const OPERATORS: Record<string, string> = {
  times: '×',
  cdot: '·',
  div: '÷',
  pm: '±',
  mp: '∓',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  neq: '≠',
  ne: '≠',
  approx: '≈',
  equiv: '≡',
  sim: '∼',
  propto: '∝',
  infty: '∞',
  sum: '∑',
  prod: '∏',
  int: '∫',
  partial: '∂',
  nabla: '∇',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  Rightarrow: '⇒',
  in: '∈',
  notin: '∉',
  subset: '⊂',
  cup: '∪',
  cap: '∩',
  forall: '∀',
  exists: '∃',
  ldots: '…',
  cdots: '⋯',
};

const FUNCTIONS = new Set(['log', 'ln', 'exp', 'sin', 'cos', 'tan', 'min', 'max', 'lim']);
const SPACES: Record<string, string> = { ',': ' ', ';': ' ', ':': ' ', quad: ' ' };
const OPERATOR_CHARS = new Set([
  '+',
  '-',
  '=',
  '<',
  '>',
  '(',
  ')',
  '[',
  ']',
  '|',
  ',',
  '.',
  ';',
  ':',
  '!',
  '/',
  '*',
  "'",
]);

class Unsupported extends Error {}

class Parser {
  #pos = 0;

  constructor(private readonly src: string) {}

  parse(): MathNode[] {
    const nodes = this.sequence(false);
    if (this.#pos < this.src.length) throw new Unsupported();
    return nodes;
  }

  private peek(): string | undefined {
    return this.src[this.#pos];
  }

  private sequence(inGroup: boolean): MathNode[] {
    const nodes: MathNode[] = [];
    for (;;) {
      this.skipSpace();
      const char = this.peek();
      if (char === undefined) {
        if (inGroup) throw new Unsupported();
        return nodes;
      }
      if (char === '}') {
        if (!inGroup) throw new Unsupported();
        return nodes;
      }
      if (char === '^' || char === '_') {
        this.scripts(nodes);
        continue;
      }
      nodes.push(...this.atom());
    }
  }

  private scripts(nodes: MathNode[]): void {
    const previous = nodes.pop();
    if (previous === undefined) throw new Unsupported();
    let target: Extract<MathNode, { kind: 'scripts' }> =
      previous.kind === 'scripts' ? previous : { kind: 'scripts', base: [previous] };
    while (this.peek() === '^' || this.peek() === '_') {
      const which = this.peek() === '^' ? 'sup' : 'sub';
      this.#pos += 1;
      if (target[which] !== undefined) {
        // `x^a^b` is an error in LaTeX; `x_a^b` is fine.
        throw new Unsupported();
      }
      const argument = this.argument();
      target = which === 'sup' ? { ...target, sup: argument } : { ...target, sub: argument };
      this.skipSpace();
    }
    nodes.push(target);
  }

  private skipSpace(): void {
    while (this.peek() === ' ' || this.peek() === '\n' || this.peek() === '\t') this.#pos += 1;
  }

  /** A braced group or a single atom (as after `^`, `_`, `\frac`). */
  private argument(): MathNode[] {
    this.skipSpace();
    if (this.peek() === '{') {
      this.#pos += 1;
      const nodes = this.sequence(true);
      this.#pos += 1;
      return nodes;
    }
    const char = this.peek();
    if (char === undefined || char === '}' || char === '^' || char === '_') throw new Unsupported();
    if (/[0-9]/u.test(char)) {
      // A bare digit argument is a single digit: `x^23` is x² followed by 3.
      this.#pos += 1;
      return [{ kind: 'number', text: char }];
    }
    return this.atom();
  }

  private atom(): MathNode[] {
    const char = this.peek();
    if (char === undefined) throw new Unsupported();
    if (char === '{') return this.argument();
    if (char === '\\') return this.command();
    if (/[0-9]/u.test(char)) {
      const match = /^[0-9]+(?:\.[0-9]+)?/u.exec(this.src.slice(this.#pos));
      const textValue = match?.[0] ?? char;
      this.#pos += textValue.length;
      return [{ kind: 'number', text: textValue }];
    }
    if (/[A-Za-z]/u.test(char)) {
      this.#pos += 1;
      return [{ kind: 'ident', text: char }];
    }
    if (OPERATOR_CHARS.has(char)) {
      this.#pos += 1;
      return [{ kind: 'op', text: char === '-' ? '−' : char }];
    }
    throw new Unsupported();
  }

  private command(): MathNode[] {
    this.#pos += 1;
    const rest = this.src.slice(this.#pos);
    const name = /^[A-Za-z]+/u.exec(rest)?.[0] ?? rest.slice(0, 1);
    if (name.length === 0) throw new Unsupported();
    this.#pos += name.length;

    const space = SPACES[name];
    if (space !== undefined) return [{ kind: 'text', text: space }];
    const greek = GREEK[name];
    if (greek !== undefined) return [{ kind: 'ident', text: greek }];
    const operator = OPERATORS[name];
    if (operator !== undefined) return [{ kind: 'op', text: operator }];
    if (FUNCTIONS.has(name)) return [{ kind: 'ident', text: name }];
    if (name === '{' || name === '}' || name === '%' || name === '&' || name === '#') {
      return [{ kind: 'op', text: name }];
    }
    if (name === 'frac') {
      const num = this.argument();
      const den = this.argument();
      return [{ kind: 'frac', num, den }];
    }
    if (name === 'sqrt') {
      this.skipSpace();
      let index: MathNode[] | undefined;
      if (this.peek() === '[') {
        const close = this.src.indexOf(']', this.#pos);
        if (close < 0) throw new Unsupported();
        index = new Parser(this.src.slice(this.#pos + 1, close)).parse();
        this.#pos = close + 1;
      }
      const body = this.argument();
      return [index === undefined ? { kind: 'sqrt', body } : { kind: 'sqrt', body, index }];
    }
    if (name === 'text' || name === 'mathrm' || name === 'textrm') {
      this.skipSpace();
      if (this.peek() !== '{') throw new Unsupported();
      const close = this.src.indexOf('}', this.#pos);
      const inner = this.src.slice(this.#pos + 1, close);
      if (close < 0 || /[\\{]/u.test(inner)) throw new Unsupported();
      this.#pos = close + 1;
      return [{ kind: 'text', text: inner }];
    }
    throw new Unsupported();
  }
}

/** Parses the supported LaTeX subset, or returns `undefined` when outside it. */
export function parseLatexMath(latex: string): MathNode[] | undefined {
  try {
    const nodes = new Parser(latex.trim()).parse();
    return nodes.length > 0 ? nodes : undefined;
  } catch (error) {
    if (error instanceof Unsupported) return undefined;
    throw error;
  }
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');

function row(nodes: readonly MathNode[]): string {
  const inner = nodes.map(mathmlNode).join('');
  return nodes.length === 1 ? inner : `<mrow>${inner}</mrow>`;
}

function mathmlNode(node: MathNode): string {
  switch (node.kind) {
    case 'ident':
      return node.text.length > 1
        ? `<mi mathvariant="normal">${escapeXml(node.text)}</mi>`
        : `<mi>${escapeXml(node.text)}</mi>`;
    case 'number':
      return `<mn>${escapeXml(node.text)}</mn>`;
    case 'op':
      return `<mo>${escapeXml(node.text)}</mo>`;
    case 'text':
      return `<mtext>${escapeXml(node.text)}</mtext>`;
    case 'frac':
      return `<mfrac>${row(node.num)}${row(node.den)}</mfrac>`;
    case 'sqrt':
      return node.index === undefined
        ? `<msqrt>${node.body.map(mathmlNode).join('')}</msqrt>`
        : `<mroot>${row(node.body)}${row(node.index)}</mroot>`;
    case 'scripts': {
      const base = row(node.base);
      if (node.sub !== undefined && node.sup !== undefined) {
        return `<msubsup>${base}${row(node.sub)}${row(node.sup)}</msubsup>`;
      }
      if (node.sub !== undefined) return `<msub>${base}${row(node.sub)}</msub>`;
      return `<msup>${base}${row(node.sup ?? [])}</msup>`;
    }
  }
}

/** MathML Core markup (rendered natively by Chromium), with the LaTeX kept as `alttext`. */
export function toMathML(nodes: readonly MathNode[], latex: string): string {
  return `<math display="block" alttext="${escapeXml(latex)}">${row(nodes)}</math>`;
}
