import type { Block, Direction, ExportDocument, Inline, Language, NoteRun } from './model';
import { parseExportDocument } from './model';
import { buildFilename, type ExportResult, WarningCollector } from './result';
import { autoDirection, blockDirection, label, splitByDirection } from './text';

const SPECIALS: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '#': '\\#',
  '%': '\\%',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

/**
 * Escapes text for LaTeX in one pass (so `\` → `\textbackslash{}` is not re-escaped).
 * Line breaks become spaces: a blank line would otherwise end the paragraph.
 * Arabic letters and tashkeel pass through unchanged (XeLaTeX reads UTF-8).
 */
export function escapeLatex(value: string): string {
  return value
    .replace(/\r\n?|\n/gu, ' ')
    .replace(/[\\{}$&#%_~^]/gu, (char) => SPECIALS[char] ?? char);
}

const POLYGLOSSIA: Record<Language, string> = { ar: 'arabic', en: 'english' };
const LANGUAGE_OF: Record<Direction, Language> = { rtl: 'ar', ltr: 'en' };

/**
 * Escaped text whose script differs from the surrounding direction is wrapped in
 * `\textenglish{}` / `\textarabic{}`, which bidi needs to order mixed runs correctly.
 */
function directional(textValue: string, base: Direction): string {
  return splitByDirection(textValue, base)
    .map((segment) => {
      const segmentDir: Direction = segment.rtl ? 'rtl' : 'ltr';
      const escaped = escapeLatex(segment.text);
      if (segmentDir === base) return escaped;
      const match = /^(\s*)(.*?)(\s*)$/su.exec(escaped);
      const [, lead = '', core = '', trail = ''] = match ?? [];
      return `${lead}\\text${POLYGLOSSIA[LANGUAGE_OF[segmentDir]]}{${core}}${trail}`;
    })
    .join('');
}

interface State {
  doc: ExportDocument;
  warnings: WarningCollector;
}

function runLatex(run: Inline | NoteRun, dir: Direction, state: State): string {
  switch (run.type) {
    case 'text': {
      let out = directional(run.text, dir);
      if (run.italic === true) out = `\\textit{${out}}`;
      if (run.bold === true) out = `\\textbf{${out}}`;
      return out;
    }
    case 'citation':
      return directional(run.text, dir);
    case 'footnote': {
      const noteText = run.content.map((part) => part.text).join('');
      const noteDir = autoDirection(noteText, dir);
      return `\\footnote{${run.content.map((part) => runLatex(part, noteDir, state)).join('')}}`;
    }
  }
}

const runsLatex = (runs: readonly Inline[], dir: Direction, state: State): string =>
  runs.map((run) => runLatex(run, dir, state)).join('');

/** A block in the other direction goes in that language's polyglossia environment. */
function withDirection(body: string, dir: Direction, doc: ExportDocument): string {
  if (dir === doc.meta.direction) return body;
  const env = POLYGLOSSIA[LANGUAGE_OF[dir]];
  return `\\begin{${env}}\n${body}\n\\end{${env}}`;
}

const UNSAFE_MATH =
  /\\(?:input|include|write|immediate|openin|openout|read|catcode|def|gdef|edef|xdef|let|newcommand|renewcommand|providecommand|csname|special|usepackage|documentclass|makeatletter|directlua|loop|end\s*\{document\}|begin\s*\{document\}|\[|\]|\(|\))|\$|(?<!\\)%|\n\s*\n/u;

/** Display math is emitted raw only when braces balance and no dangerous primitive appears. */
export function isSafeLatexMath(latex: string): boolean {
  if (UNSAFE_MATH.test(latex)) return false;
  let depth = 0;
  for (let i = 0; i < latex.length; i += 1) {
    const char = latex[i];
    if (char === '\\') {
      i += 1; // skip the escaped character, e.g. \{ or \}
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

const HEADING_COMMANDS = ['chapter', 'section', 'subsection', 'subsubsection'] as const;

function blockLatex(block: Block, state: State): string {
  const { doc } = state;
  const dir = blockDirection(block, doc);
  switch (block.type) {
    case 'heading': {
      const command = HEADING_COMMANDS[block.level - 1] ?? 'subsubsection';
      const title = directional(block.text, dir);
      // Unnumbered: headings carry their own numbering text, as in the editor.
      return withDirection(
        `\\${command}*{${title}}\n\\addcontentsline{toc}{${command}}{${title}}`,
        dir,
        doc,
      );
    }
    case 'paragraph':
      return withDirection(runsLatex(block.runs, dir, state), dir, doc);
    case 'blockquote':
      return withDirection(
        `\\begin{quote}\n${runsLatex(block.runs, dir, state)}\n\\end{quote}`,
        dir,
        doc,
      );
    case 'list': {
      const env = block.ordered ? 'enumerate' : 'itemize';
      // `\item{}` stops an item that starts with "[" being read as an optional label.
      const items = block.items.map((item) => `  \\item{} ${runsLatex(item, dir, state)}`);
      return withDirection(`\\begin{${env}}\n${items.join('\n')}\n\\end{${env}}`, dir, doc);
    }
    case 'table': {
      const columns = `|${block.header.map(() => 'X|').join('')}`;
      const row = (cells: readonly string[], bold = false) =>
        `${cells.map((cell) => (bold ? `\\textbf{${directional(cell, dir)}}` : directional(cell, dir))).join(' & ')} \\\\ \\hline`;
      const lines = [
        ...(block.caption === undefined
          ? []
          : [`\\begin{center}\\textbf{${directional(block.caption, dir)}}\\end{center}`]),
        `\\noindent\\begin{tabularx}{\\linewidth}{${columns}}`,
        '\\hline',
        row(block.header, true),
        ...block.rows.map((cells) => row(cells)),
        '\\end{tabularx}',
      ];
      return withDirection(lines.join('\n'), dir, doc);
    }
    case 'image': {
      state.warnings.add('IMAGE_SKIPPED');
      const placeholder = directional(
        label(doc.meta.language, 'imageOmitted', { alt: block.alt }),
        dir,
      );
      const caption = block.caption === undefined ? '' : `\\\\\n${directional(block.caption, dir)}`;
      return withDirection(`\\begin{center}\n${placeholder}${caption}\n\\end{center}`, dir, doc);
    }
    case 'equation': {
      if (isSafeLatexMath(block.latex)) {
        return `\\begin{LTR}\n\\[\n${block.latex.trim()}\n\\]\n\\end{LTR}`;
      }
      state.warnings.add('EQUATION_AS_TEXT');
      return `\\begin{center}\n\\texttt{${escapeLatex(block.fallbackText ?? block.latex)}}\n\\end{center}`;
    }
  }
}

function coverLatex(doc: ExportDocument): string {
  const { meta } = doc;
  const base = meta.direction;
  const line = (value: string | undefined, size = '') =>
    value === undefined || value.trim() === ''
      ? []
      : [`{${size}${directional(value, base)}\\par}`, '\\vspace{1em}'];
  return [
    '\\begin{titlepage}',
    '\\centering',
    ...line(meta.institution, '\\large '),
    ...line(meta.department),
    '\\vfill',
    ...line(meta.title, '\\Huge\\bfseries '),
    ...line(meta.subtitle, '\\Large '),
    ...line(meta.degree),
    '\\vfill',
    ...line(`${label(meta.language, 'preparedBy')}: ${meta.author}`, '\\large '),
    ...(meta.supervisor === undefined
      ? []
      : line(`${label(meta.language, 'supervisedBy')}: ${meta.supervisor}`, '\\large ')),
    ...line(meta.date),
    '\\end{titlepage}',
  ].join('\n');
}

/**
 * A XeLaTeX source (KOMA `scrreprt`, `polyglossia` with `bidi`). The file is meant to be
 * compiled by the researcher with XeLaTeX; this package does not compile it.
 */
export function renderLatex(doc: ExportDocument, warnings: WarningCollector): string {
  const { meta, template } = doc;
  const rtl = meta.direction === 'rtl';
  const left = rtl ? template.margins.end : template.margins.start;
  const right = rtl ? template.margins.start : template.margins.end;
  const main = POLYGLOSSIA[meta.language];
  const other = meta.language === 'ar' ? 'english' : 'arabic';
  const arabicFont = meta.language === 'ar' ? template.fontFamily : 'Noto Naskh Arabic';
  const paper = template.pageSize === 'A4' ? 'a4' : 'letter';
  const state: State = { doc, warnings };

  const preamble = [
    '% !TEX program = xelatex',
    '% Generated by BAHITH (@bahith/export). Compile with XeLaTeX.',
    `\\documentclass[fontsize=${template.fontSizePt}pt,paper=${paper},oneside]{scrreprt}`,
    `\\usepackage[top=${template.margins.top}mm,bottom=${template.margins.bottom}mm,left=${left}mm,right=${right}mm]{geometry}`,
    '\\usepackage{fontspec}',
    '\\usepackage{amsmath}',
    '\\usepackage{tabularx}',
    '\\usepackage{setspace}',
    `\\setstretch{${template.lineSpacing}}`,
    '\\usepackage{polyglossia}',
    `\\setmainlanguage{${main}}`,
    `\\setotherlanguage{${other}}`,
    `\\setmainfont{${template.fontFamily}}`,
    `\\newfontfamily\\arabicfont[Script=Arabic]{${arabicFont}}`,
    // bidi must be the last package; polyglossia would load it, this makes it explicit.
    '\\usepackage{bidi}',
    template.pageNumbers
      ? '\\pagestyle{plain}'
      : '\\pagestyle{empty}\n\\renewcommand*{\\chapterpagestyle}{empty}',
  ];

  const body: string[] = [];
  if (template.coverPage) body.push(coverLatex(doc));
  if (template.tableOfContents) body.push('\\tableofcontents\n\\clearpage');
  for (const block of doc.body) body.push(blockLatex(block, state));

  const heading = directional(doc.bibliography.heading, meta.direction);
  body.push(`\\chapter*{${heading}}\n\\addcontentsline{toc}{chapter}{${heading}}`);
  for (const entry of doc.bibliography.entries) {
    const dir = autoDirection(entry, meta.direction);
    body.push(
      withDirection(
        `\\noindent\\hangindent=2em\\hangafter=1 ${directional(entry, dir)}\\par`,
        dir,
        doc,
      ),
    );
  }

  return `${preamble.join('\n')}\n\n\\begin{document}\n\n${body.join('\n\n')}\n\n\\end{document}\n`;
}

export function exportLatex(input: unknown): ExportResult {
  const doc = parseExportDocument(input);
  const warnings = new WarningCollector();
  const latex = renderLatex(doc, warnings);
  return {
    bytes: new TextEncoder().encode(latex),
    mime: 'application/x-tex; charset=utf-8',
    filename: buildFilename(doc.meta.title, 'latex'),
    warnings: warnings.toArray(),
  };
}
