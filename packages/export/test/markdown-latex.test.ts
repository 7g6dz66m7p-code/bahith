import { describe, expect, it } from 'vitest';

import {
  escapeLatex,
  escapeMarkdown,
  type ExportDocument,
  exportLatex,
  exportMarkdown,
  isSafeLatexMath,
} from '../src';
import { arabicTemplate, FOOTNOTE_TEXT, sampleArabicDocument, TASHKEEL } from './fixtures';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Synthetic test text; the citation and references are fictitious placeholders. */
const small: ExportDocument = {
  meta: { title: 'عنوان', author: 'باحث', language: 'ar', direction: 'rtl' },
  template: { ...arabicTemplate, coverPage: false, tableOfContents: false },
  body: [
    { type: 'heading', level: 1, text: 'الفصل الأول' },
    {
      type: 'paragraph',
      runs: [
        { type: 'text', text: 'نسبة 50% & $5 #1 _a_ *b* [c] <d> | ~e ^f \\g ' },
        { type: 'text', text: 'مهم', bold: true },
        { type: 'footnote', content: [{ type: 'text', text: 'حاشية *أولى*' }] },
        { type: 'citation', text: '(الباحث، ٢٠٢٠)', sourceId: 'src-1' },
      ],
    },
    { type: 'paragraph', dir: 'ltr', runs: [{ type: 'text', text: 'English text' }] },
  ],
  bibliography: { heading: 'المراجع', entries: ['مرجع أول.', 'Author, A. (2020). Title.'] },
};

describe('exportMarkdown', () => {
  it('produces the exact Markdown: front matter, escaping, [^n] footnotes, direction blocks', () => {
    const result = exportMarkdown(small);
    expect(result.mime).toBe('text/markdown; charset=utf-8');
    expect(result.filename).toBe('عنوان.md');
    expect(result.warnings).toEqual([]);
    expect(decode(result.bytes)).toBe(
      [
        '---',
        'title: "عنوان"',
        'author: "باحث"',
        'lang: ar',
        'dir: rtl',
        '---',
        '',
        '# الفصل الأول',
        '',
        'نسبة 50% \\& \\$5 #1 \\_a\\_ \\*b\\* \\[c\\] \\<d\\> \\| \\~e ^f \\\\g **مهم**[^1](الباحث، ٢٠٢٠)',
        '',
        '<div dir="ltr">',
        '',
        'English text',
        '',
        '</div>',
        '',
        '# المراجع',
        '',
        'مرجع أول.',
        '',
        '<div dir="ltr">',
        '',
        'Author, A. (2020). Title.',
        '',
        '</div>',
        '',
        '[^1]: حاشية \\*أولى\\*',
        '',
      ].join('\n'),
    );
  });

  it('numbers footnotes in document order across blocks and keeps tashkeel', () => {
    const markdown = decode(exportMarkdown(sampleArabicDocument()).bytes);
    expect(markdown).toContain(TASHKEEL);
    expect(markdown).toContain(`[^1]: ${FOOTNOTE_TEXT}`);
    expect(markdown).toContain('[^2]: حاشية الفصل الثاني.');
    expect(markdown.indexOf('[^1]')).toBeLessThan(markdown.indexOf('[^2]'));
    expect(markdown).toContain('$$\n\\frac{a}{b} + x^{2}\n$$');
  });

  it('warns when an image cannot be embedded in a text format', () => {
    const result = exportMarkdown(sampleArabicDocument());
    expect(result.warnings).toContainEqual({ code: 'IMAGE_SKIPPED', count: 1 });
    expect(decode(result.bytes)).toContain('\\[صورة غير مضمّنة: شكل تجريبي\\]');
  });

  it('escapes block markers at the start of a line', () => {
    expect(escapeMarkdown('# not a heading')).toBe('\\# not a heading');
    expect(escapeMarkdown('1. not a list')).toBe('1\\. not a list');
    expect(escapeMarkdown('- not a bullet')).toBe('\\- not a bullet');
    expect(escapeMarkdown('سطر\nآخر')).toBe('سطر آخر');
  });
});

describe('exportLatex', () => {
  it('escapes every LaTeX special character in one pass', () => {
    expect(escapeLatex('% & $ # _ { } ~ ^ \\')).toBe(
      '\\% \\& \\$ \\# \\_ \\{ \\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{}',
    );
    expect(escapeLatex('\\textbf{x}')).toBe('\\textbackslash{}textbf\\{x\\}');
  });

  it('escapes specials inside Arabic text and leaves Arabic letters and tashkeel untouched', () => {
    expect(escapeLatex('نسبة ٥٠% & أكثر_من {النصف}')).toBe('نسبة ٥٠\\% \\& أكثر\\_من \\{النصف\\}');
    expect(escapeLatex(TASHKEEL)).toBe(TASHKEEL);
  });

  it('sets up XeLaTeX with polyglossia + bidi for an Arabic document', () => {
    const result = exportLatex(sampleArabicDocument());
    const tex = decode(result.bytes);
    expect(result.mime).toBe('application/x-tex; charset=utf-8');
    expect(result.filename).toBe('أثر-التعلم-المدمج-في-التحصيل.tex');
    expect(tex.startsWith('% !TEX program = xelatex\n')).toBe(true);
    for (const line of [
      '\\documentclass[fontsize=14pt,paper=a4,oneside]{scrreprt}',
      '\\usepackage[top=25mm,bottom=25mm,left=25mm,right=30mm]{geometry}',
      '\\usepackage{polyglossia}',
      '\\setmainlanguage{arabic}',
      '\\setotherlanguage{english}',
      '\\setmainfont{Noto Naskh Arabic}',
      '\\newfontfamily\\arabicfont[Script=Arabic]{Noto Naskh Arabic}',
      '\\usepackage{bidi}',
      '\\setstretch{1.5}',
      '\\pagestyle{plain}',
      '\\begin{titlepage}',
      '\\tableofcontents',
    ]) {
      expect(tex).toContain(line);
    }
    // bidi is the last package loaded.
    expect(tex.lastIndexOf('\\usepackage')).toBe(tex.indexOf('\\usepackage{bidi}'));
  });

  it('writes footnotes, headings, direction switches and the bibliography', () => {
    const tex = decode(exportLatex(sampleArabicDocument()).bytes);
    expect(tex).toContain(`\\footnote{${FOOTNOTE_TEXT}}`);
    expect(tex).toContain(
      '\\chapter*{الفصل الأول: مقدمة الدراسة}\n\\addcontentsline{toc}{chapter}{الفصل الأول: مقدمة الدراسة}',
    );
    expect(tex).toContain('\\section*{المبحث الأول: مشكلة الدراسة}');
    expect(tex).toContain('\\subsection*{المطلب الأول: أسئلة الدراسة}');
    expect(tex).toContain(
      '\\begin{english}\nThis paragraph is written in English inside an Arabic thesis.\n\\end{english}',
    );
    expect(tex).toContain(`${TASHKEEL}، \\textbf{وهذه جملة عريضة}`);
    expect(tex).toContain('\\textit{جملة مائلة}');
    expect(tex).toContain('\\begin{LTR}\n\\[\n\\frac{a}{b} + x^{2}\n\\]\n\\end{LTR}');
    expect(tex).toContain('\\begin{english}\n\\noindent\\hangindent=2em\\hangafter=1 Author, A.');
    expect(tex.trimEnd().endsWith('\\end{document}')).toBe(true);
  });

  it('wraps a Latin word inside an Arabic paragraph in \\textenglish', () => {
    const tex = decode(
      exportLatex(
        sampleArabicDocument({
          body: [{ type: 'paragraph', runs: [{ type: 'text', text: 'يرى Smith & Lee أن' }] }],
        }),
      ).bytes,
    );
    expect(tex).toContain('يرى \\textenglish{Smith \\& Lee} أن');
  });

  it('uses English as the main language for an LTR document', () => {
    const base = sampleArabicDocument();
    const tex = decode(
      exportLatex({
        ...base,
        meta: { ...base.meta, language: 'en', direction: 'ltr' },
        template: { ...base.template, fontFamily: 'Times New Roman', pageNumbers: false },
      }).bytes,
    );
    expect(tex).toContain('\\setmainlanguage{english}');
    expect(tex).toContain('\\setotherlanguage{arabic}');
    expect(tex).toContain('\\newfontfamily\\arabicfont[Script=Arabic]{Noto Naskh Arabic}');
    expect(tex).toContain('\\usepackage[top=25mm,bottom=25mm,left=30mm,right=25mm]{geometry}');
    expect(tex).toContain('\\pagestyle{empty}');
    // Arabic text inside an English document switches language inline.
    expect(tex).toContain('\\chapter*{\\textarabic{الفصل الأول: مقدمة الدراسة}}');
  });

  it('refuses to pass dangerous or malformed equation source through raw', () => {
    expect(isSafeLatexMath('\\frac{a}{b}')).toBe(true);
    expect(isSafeLatexMath('\\begin{pmatrix} a & b \\end{pmatrix}')).toBe(true);
    for (const bad of [
      '\\input{/etc/passwd}',
      'x \\end{document}',
      '\\immediate\\write18{rm -rf /}',
      'a}{b',
      '{a',
      'x \\] \\section{y}',
      'x % comment hides \\]',
      'a\n\nb',
    ]) {
      expect(isSafeLatexMath(bad)).toBe(false);
    }
    const result = exportLatex(
      sampleArabicDocument({ body: [{ type: 'equation', latex: '\\input{/etc/passwd}' }] }),
    );
    const tex = decode(result.bytes);
    expect(tex).toContain('\\texttt{\\textbackslash{}input\\{/etc/passwd\\}}');
    expect(tex).not.toContain('\\input{');
    expect(result.warnings).toContainEqual({ code: 'EQUATION_AS_TEXT', count: 1 });
  });
});
