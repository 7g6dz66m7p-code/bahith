import { describe, expect, it } from 'vitest';

import {
  ExportError,
  exportDocument,
  type ExportFormat,
  exportHtml,
  parseExportDocument,
} from '../src';
import { sampleArabicDocument } from './fixtures';

function issuesOf(input: unknown): {
  code: string;
  issues: readonly { path: string; code: string }[];
} {
  try {
    parseExportDocument(input);
  } catch (error) {
    if (error instanceof ExportError) return { code: error.code, issues: error.issues };
    throw error;
  }
  throw new Error('expected validation to fail');
}

describe('validation → typed ExportError with stable codes', () => {
  it('accepts the sample document', () => {
    expect(() => parseExportDocument(sampleArabicDocument())).not.toThrow();
  });

  it('rejects a heading level outside 1–4', () => {
    for (const level of [0, 5, 1.5]) {
      const doc = sampleArabicDocument({ body: [{ type: 'heading', level, text: 'عنوان' }] });
      expect(issuesOf(doc)).toEqual({
        code: 'EXPORT_INVALID_DOCUMENT',
        issues: [{ path: 'body.0.level', code: 'INVALID_HEADING_LEVEL' }],
      });
    }
  });

  it('rejects an empty or whitespace-only title', () => {
    for (const title of ['', '   \n']) {
      const base = sampleArabicDocument();
      expect(issuesOf({ ...base, meta: { ...base.meta, title } })).toEqual({
        code: 'EXPORT_INVALID_DOCUMENT',
        issues: [{ path: 'meta.title', code: 'EMPTY_TITLE' }],
      });
    }
  });

  it('reports table rows whose width differs from the header', () => {
    const doc = sampleArabicDocument({
      body: [{ type: 'table', header: ['أ', 'ب'], rows: [['١']] }],
    });
    expect(issuesOf(doc).issues).toEqual([
      { path: 'body.0.rows', code: 'TABLE_ROW_WIDTH_MISMATCH' },
    ]);
  });

  it('rejects unknown block types, unknown keys, and bad enums', () => {
    const base = sampleArabicDocument();
    expect(issuesOf({ ...base, body: [{ type: 'video' }] }).issues[0]?.code).toBe('INVALID_BLOCK');
    expect(issuesOf({ ...base, meta: { ...base.meta, direction: 'up' } }).issues).toEqual([
      { path: 'meta.direction', code: 'INVALID_DIRECTION' },
    ]);
    expect(issuesOf({ ...base, extra: true }).issues[0]?.path).toBe('');
    expect(
      issuesOf({ ...base, template: { ...base.template, fontFamily: "x'; } body { color: red" } })
        .issues,
    ).toEqual([{ path: 'template.fontFamily', code: 'INVALID_FONT_FAMILY' }]);
  });

  it('rejects images without alt text and citations without a source id', () => {
    const doc = sampleArabicDocument({
      body: [
        { type: 'image', data: new Uint8Array([1]), mime: 'image/png', alt: ' ' },
        { type: 'paragraph', runs: [{ type: 'citation', text: '(أ، ٢٠٢٠)', sourceId: '' }] },
      ],
    });
    expect(issuesOf(doc).issues).toEqual([
      { path: 'body.0.alt', code: 'MISSING_IMAGE_ALT' },
      { path: 'body.1.runs.0.sourceId', code: 'MISSING_SOURCE_ID' },
    ]);
  });

  it('never copies document text into the error', () => {
    const secret = 'نص بحثي سري لا يجوز أن يظهر في السجلات';
    const base = sampleArabicDocument();
    try {
      parseExportDocument({
        ...base,
        meta: { ...base.meta, title: '', subtitle: 42, author: secret },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExportError);
      const serialised = JSON.stringify(error) + String(error) + (error as Error).message;
      expect(serialised).not.toContain(secret);
    }
  });

  it('every exporter validates before doing any work', async () => {
    const base = sampleArabicDocument();
    const bad = { ...base, meta: { ...base.meta, title: '' } };
    const formats: ExportFormat[] = ['docx', 'pdf', 'html', 'markdown', 'latex'];
    for (const format of formats) {
      await expect(exportDocument(bad, format)).rejects.toMatchObject({
        name: 'ExportError',
        code: 'EXPORT_INVALID_DOCUMENT',
      });
    }
    expect(() => exportHtml(null)).toThrow(ExportError);
  });
});
