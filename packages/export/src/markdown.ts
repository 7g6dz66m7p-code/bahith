import type { Block, Direction, ExportDocument, Inline, NoteRun } from './model';
import { parseExportDocument } from './model';
import { buildFilename, type ExportResult, WarningCollector } from './result';
import { autoDirection, blockDirection, label } from './text';

/** Backslash-escapes Markdown syntax so document text is never read as markup. */
export function escapeMarkdown(value: string): string {
  return value
    .replace(/\r\n?|\n/gu, ' ')
    .replace(/[\\`*_[\]<>|~$&]/gu, (char) => `\\${char}`)
    .replace(/^(\s*)([#+=-])/u, '$1\\$2')
    .replace(/^(\s*\d+)([.)])/u, '$1\\$2');
}

/** Wraps emphasis markers around the text but keeps edge whitespace outside them. */
function emphasize(textValue: string, marker: string): string {
  const match = /^(\s*)(.*?)(\s*)$/su.exec(textValue);
  const [, lead = '', core = '', trail = ''] = match ?? [];
  return core.length === 0 ? textValue : `${lead}${marker}${core}${marker}${trail}`;
}

interface State {
  doc: ExportDocument;
  warnings: WarningCollector;
  notes: string[];
}

function runMarkdown(run: Inline | NoteRun, state: State): string {
  switch (run.type) {
    case 'text': {
      let out = escapeMarkdown(run.text);
      if (run.italic === true) out = emphasize(out, '*');
      if (run.bold === true) out = emphasize(out, '**');
      return out;
    }
    case 'citation':
      return escapeMarkdown(run.text);
    case 'footnote': {
      const n = state.notes.length + 1;
      state.notes.push(''); // reserve the number before rendering the content
      state.notes[n - 1] = run.content.map((part) => runMarkdown(part, state)).join('');
      return `[^${n}]`;
    }
  }
}

const runsMarkdown = (runs: readonly Inline[], state: State): string =>
  runs.map((run) => runMarkdown(run, state)).join('');

/** A block whose direction differs from the document's is wrapped in an HTML `dir` div. */
function withDirection(markdown: string, dir: Direction, doc: ExportDocument): string {
  return dir === doc.meta.direction ? markdown : `<div dir="${dir}">\n\n${markdown}\n\n</div>`;
}

function fence(content: string, info = ''): string {
  const longest = Math.max(0, ...(content.match(/`+/gu) ?? []).map((ticks) => ticks.length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${info}\n${content}\n${ticks}`;
}

function blockMarkdown(block: Block, state: State): string {
  const { doc } = state;
  const dir = blockDirection(block, doc);
  switch (block.type) {
    case 'heading':
      return withDirection(`${'#'.repeat(block.level)} ${escapeMarkdown(block.text)}`, dir, doc);
    case 'paragraph':
      return withDirection(runsMarkdown(block.runs, state), dir, doc);
    case 'blockquote':
      return withDirection(`> ${runsMarkdown(block.runs, state)}`, dir, doc);
    case 'list':
      return withDirection(
        block.items
          .map((item, i) => `${block.ordered ? `${i + 1}.` : '-'} ${runsMarkdown(item, state)}`)
          .join('\n'),
        dir,
        doc,
      );
    case 'table': {
      const rowLine = (cells: readonly string[]) =>
        `| ${cells.map((cell) => escapeMarkdown(cell)).join(' | ')} |`;
      const lines = [
        rowLine(block.header),
        `| ${block.header.map(() => '---').join(' | ')} |`,
        ...block.rows.map(rowLine),
      ];
      const caption = block.caption === undefined ? '' : `${escapeMarkdown(block.caption)}\n\n`;
      return withDirection(`${caption}${lines.join('\n')}`, dir, doc);
    }
    case 'image': {
      // A single-file text format cannot carry the bytes; say so instead of linking nothing.
      state.warnings.add('IMAGE_SKIPPED');
      const placeholder = escapeMarkdown(
        label(doc.meta.language, 'imageOmitted', { alt: block.alt }),
      );
      const caption = block.caption === undefined ? '' : `\n\n${escapeMarkdown(block.caption)}`;
      return withDirection(`${placeholder}${caption}`, dir, doc);
    }
    case 'equation':
      if (block.latex.includes('$$')) {
        state.warnings.add('EQUATION_AS_TEXT');
        return fence(block.fallbackText ?? block.latex);
      }
      return `$$\n${block.latex.trim()}\n$$`;
  }
}

/**
 * Markdown (CommonMark + GFM tables + Pandoc/GFM `[^n]` footnotes) with a YAML front
 * matter carrying title, author, language and direction.
 */
export function renderMarkdown(doc: ExportDocument, warnings: WarningCollector): string {
  const state: State = { doc, warnings, notes: [] };
  const { meta } = doc;
  const yaml = (key: string, value: string | undefined) =>
    value === undefined ? [] : [`${key}: ${JSON.stringify(value)}`];
  const front = [
    '---',
    ...yaml('title', meta.title),
    ...yaml('subtitle', meta.subtitle),
    ...yaml('author', meta.author),
    ...yaml('supervisor', meta.supervisor),
    ...yaml('institution', meta.institution),
    ...yaml('department', meta.department),
    ...yaml('degree', meta.degree),
    ...yaml('date', meta.date),
    `lang: ${meta.language}`,
    `dir: ${meta.direction}`,
    '---',
  ].join('\n');

  const parts: string[] = [front];
  if (doc.template.tableOfContents) {
    const items = doc.body
      .filter((block) => block.type === 'heading')
      .map((block) => `${'  '.repeat(block.level - 1)}- ${escapeMarkdown(block.text)}`);
    items.push(`- ${escapeMarkdown(doc.bibliography.heading)}`);
    parts.push(
      `**${escapeMarkdown(label(meta.language, 'tableOfContents'))}**\n\n${items.join('\n')}`,
    );
  }
  for (const block of doc.body) parts.push(blockMarkdown(block, state));

  parts.push(`# ${escapeMarkdown(doc.bibliography.heading)}`);
  for (const entry of doc.bibliography.entries) {
    parts.push(withDirection(escapeMarkdown(entry), autoDirection(entry, meta.direction), doc));
  }
  if (state.notes.length > 0) {
    parts.push(state.notes.map((note, i) => `[^${i + 1}]: ${note}`).join('\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

export function exportMarkdown(input: unknown): ExportResult {
  const doc = parseExportDocument(input);
  const warnings = new WarningCollector();
  const markdown = renderMarkdown(doc, warnings);
  return {
    bytes: new TextEncoder().encode(markdown),
    mime: 'text/markdown; charset=utf-8',
    filename: buildFilename(doc.meta.title, 'markdown'),
    warnings: warnings.toArray(),
  };
}
