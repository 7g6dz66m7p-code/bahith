import type { CitationTarget } from '@bahith/db';
import { parseExportDocument } from '@bahith/export';
import { describe, expect, it } from 'vitest';

import { collectCitations, draftToExportDocument, targetKey } from '@/server/draft-export';
import type { DraftNode } from '@/server/draft-export';

const SOURCE = '11111111-1111-4111-8111-111111111111';
const CHUNK = '22222222-2222-4222-8222-222222222222';

const target: CitationTarget = {
  sourceId: SOURCE,
  source: {
    type: 'document',
    title: 'منهج البحث',
    authors: [],
    year: null,
    containerTitle: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    doi: null,
    url: null,
    language: null,
    verificationStatus: 'unverified',
    fullTextStatus: 'full_text',
  },
  chunk: { id: CHUNK, pageStart: 7, pageEnd: 7, kind: 'full_text' },
};

const draft: DraftNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'الفصل الأول' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'تعتمد الدراسة على المصادر', marks: [{ type: 'bold' }] },
        // The editor's page attribute is a lie on purpose: the export must ignore it.
        { type: 'citation', attrs: { sourceId: SOURCE, chunkId: CHUNK, page: 999 } },
        { type: 'footnote', attrs: { text: 'حاشية توضيحية' } },
      ],
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'An English paragraph.' }] },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'المتغير' }] }],
            },
          ],
        },
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'التحصيل' }] }],
            },
          ],
        },
      ],
    },
    { type: 'paragraph' },
  ],
};

describe('draftToExportDocument', () => {
  it('collects citations from text and footnotes in order', () => {
    expect(collectCitations(draft)).toEqual([{ sourceId: SOURCE, chunkId: CHUNK }]);
  });

  it('builds a valid export document; pages come from the stored passage only', () => {
    const formatted: CitationTarget[] = [];
    const result = draftToExportDocument({
      doc: draft,
      title: 'مسودة',
      author: 'باحثة',
      language: 'ar',
      bibliographyHeading: 'المصادر والمراجع',
      bibliography: ['منهج البحث. (د.ت).'],
      formatCitation: (t) => {
        formatted.push(t);
        return `(منهج البحث، د.ت، ص ${t.chunk?.pageStart})`;
      },
      targets: new Map([[targetKey({ sourceId: SOURCE, chunkId: CHUNK }), target]]),
    });
    expect(() => parseExportDocument(result)).not.toThrow();
    expect(result.meta.direction).toBe('rtl');
    const [heading, paragraph, english, table] = result.body;
    expect(heading).toEqual({ type: 'heading', level: 1, text: 'الفصل الأول', dir: 'rtl' });
    expect(paragraph).toMatchObject({ type: 'paragraph', dir: 'rtl' });
    const runs = paragraph?.type === 'paragraph' ? paragraph.runs : [];
    expect(runs[0]).toEqual({ type: 'text', text: 'تعتمد الدراسة على المصادر', bold: true });
    expect(runs[1]).toEqual({
      type: 'citation',
      text: '(منهج البحث، د.ت، ص 7)',
      sourceId: SOURCE,
      locator: '7',
    });
    expect(JSON.stringify(result)).not.toContain('999');
    expect(runs[2]).toEqual({
      type: 'footnote',
      content: [{ type: 'text', text: 'حاشية توضيحية' }],
    });
    expect(english).toMatchObject({ type: 'paragraph', dir: 'ltr' });
    expect(table).toEqual({ type: 'table', header: ['المتغير'], rows: [['التحصيل']], dir: 'rtl' });
    expect(result.body).toHaveLength(4); // the empty paragraph is dropped
  });

  it('drops a citation whose source was not resolved instead of inventing one', () => {
    const result = draftToExportDocument({
      doc: draft,
      title: 'مسودة',
      author: 'باحثة',
      language: 'ar',
      bibliographyHeading: 'المصادر',
      bibliography: [],
      formatCitation: () => 'should not be called',
      targets: new Map(),
    });
    expect(JSON.stringify(result)).not.toContain('citation');
  });
});
