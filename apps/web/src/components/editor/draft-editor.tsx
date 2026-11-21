'use client';

import { TableKit } from '@tiptap/extension-table';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { diffWords } from 'diff';
import { useTranslations } from 'next-intl';
import type { SubmitEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Link } from '@/i18n/navigation';

import { Citation, Footnote } from './nodes';

interface DraftEditorProps {
  workspaceId: string;
  projectId: string;
  documentId: string;
  title: string;
  initialVersion: number;
  initialContent: Record<string, unknown>;
  canWrite: boolean;
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

interface Evidence {
  chunkId: string;
  fileId: string | null;
  sourceId: string;
  sourceTitle: string;
  content: string;
  pageStart: number | null;
}

interface VersionInfo {
  version: number;
  kind: 'autosave' | 'manual';
  createdAt: string;
}

const AUTOSAVE_MS = 5_000;
const EXPORT_FORMATS = ['docx', 'pdf', 'markdown', 'latex'] as const;
const KNOWN_WARNINGS = [
  'UNVERIFIED_SOURCES',
  'FOOTNOTES_AS_CHAPTER_NOTES',
  'TOC_NEEDS_FIELD_UPDATE',
  'TOC_WITHOUT_PAGE_NUMBERS',
  'PDF_BOOKMARKS_OMITTED',
  'FONT_FALLBACK',
] as const;
type KnownWarning = (typeof KNOWN_WARNINGS)[number];
const isKnownWarning = (code: string): code is KnownWarning =>
  (KNOWN_WARNINGS as readonly string[]).includes(code);

function textOf(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  const value = node as { type?: string; text?: string; content?: unknown[] };
  if (value.type === 'text') return value.text ?? '';
  const inner = (value.content ?? []).map(textOf).join('');
  return ['paragraph', 'heading', 'listItem', 'blockquote'].includes(value.type ?? '')
    ? `${inner}\n`
    : inner;
}

export function DraftEditor(props: DraftEditorProps) {
  const t = useTranslations('Draft');
  const query = `workspaceId=${props.workspaceId}`;
  const base = `/api/projects/${props.projectId}/documents/${props.documentId}`;
  const fileUrl = (fileId: string, page: number | null) =>
    `/api/projects/${props.projectId}/files/${fileId}?${query}${page === null ? '' : `#page=${page}`}`;

  const version = useRef(props.initialVersion);
  const dirty = useRef(false);
  const hasUnsavedEdits = () => dirty.current;
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [panel, setPanel] = useState<'none' | 'cite' | 'footnote' | 'versions'>('none');
  const [evidence, setEvidence] = useState<Evidence[] | null>(null);
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [comparison, setComparison] = useState<{
    version: number;
    parts: ReturnType<typeof diffWords>;
    content: Record<string, unknown>;
  } | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<{ ok: boolean; warnings: string[] } | null>(
    null,
  );

  const editor = useEditor({
    immediatelyRender: false,
    editable: props.canWrite,
    // Every block gets dir="auto": Arabic and English paragraphs each read correctly.
    textDirection: 'auto',
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
      TableKit.configure({ table: { resizable: false } }),
      Citation,
      Footnote,
    ],
    content: props.initialContent,
    editorProps: {
      attributes: {
        class: 'draft-content',
        'aria-label': t('editorLabel'),
        role: 'textbox',
        'aria-multiline': 'true',
      },
      // A citation opens its source at the cited page.
      handleClickOn: (_view, _pos, node) => {
        if (node.type.name !== 'citation') return false;
        const fileId = node.attrs.fileId as string | null;
        const page = node.attrs.page as number | null;
        if (fileId !== null) window.open(fileUrl(fileId, page), '_blank', 'noopener,noreferrer');
        return true;
      },
    },
    onUpdate: () => {
      dirty.current = true;
      setSaveState((state) => (state === 'conflict' ? state : 'dirty'));
    },
  });

  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive('bold') ?? false,
      italic: current?.isActive('italic') ?? false,
      h1: current?.isActive('heading', { level: 1 }) ?? false,
      h2: current?.isActive('heading', { level: 2 }) ?? false,
      h3: current?.isActive('heading', { level: 3 }) ?? false,
      bullet: current?.isActive('bulletList') ?? false,
      ordered: current?.isActive('orderedList') ?? false,
      quote: current?.isActive('blockquote') ?? false,
    }),
  });

  const save = useCallback(
    async (kind: 'autosave' | 'manual') => {
      if (editor === null || !props.canWrite) return;
      if (kind === 'autosave' && !dirty.current) return;
      setSaveState('saving');
      const content = editor.getJSON();
      dirty.current = false;
      try {
        const response = await fetch(`${base}?${query}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, baseVersion: version.current, kind }),
        });
        if (response.status === 409) {
          setSaveState('conflict');
          return;
        }
        if (!response.ok) throw new Error('save failed');
        const body = (await response.json()) as { version: number };
        version.current = body.version;
        // Edits typed while the request was in flight set the flag again.
        setSaveState(hasUnsavedEdits() ? 'dirty' : 'saved');
      } catch {
        dirty.current = true;
        setSaveState('error');
      }
    },
    [base, editor, props.canWrite, query],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      if (saveState !== 'conflict' && saveState !== 'saving') void save('autosave');
    }, AUTOSAVE_MS);
    return () => {
      clearInterval(timer);
    };
  }, [save, saveState]);

  const searchEvidence = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get('query');
    if (typeof text !== 'string' || text.trim() === '') return;
    const response = await fetch('/api/sanad/retrieve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: props.workspaceId,
        projectId: props.projectId,
        query: text.trim(),
        limit: 8,
      }),
    });
    setEvidence(response.ok ? ((await response.json()) as { results: Evidence[] }).results : []);
  };

  const insertCitation = (item: Evidence) => {
    const label =
      item.pageStart === null
        ? `[${item.sourceTitle}]`
        : `[${item.sourceTitle}${t('pageSuffix', { page: item.pageStart })}]`;
    editor
      ?.chain()
      .focus()
      .insertContent({
        type: 'citation',
        attrs: {
          sourceId: item.sourceId,
          chunkId: item.chunkId,
          fileId: item.fileId,
          page: item.pageStart,
          label,
        },
      })
      .run();
    setPanel('none');
  };

  const insertFootnote = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get('footnote');
    if (typeof text !== 'string' || text.trim() === '') return;
    editor
      ?.chain()
      .focus()
      .insertContent({ type: 'footnote', attrs: { text: text.trim() } })
      .run();
    setPanel('none');
  };

  const openVersions = async () => {
    setPanel(panel === 'versions' ? 'none' : 'versions');
    setComparison(null);
    const response = await fetch(`${base}/versions?${query}`, { cache: 'no-store' });
    if (response.ok) setVersions(((await response.json()) as { versions: VersionInfo[] }).versions);
  };

  const compareWith = async (number: number) => {
    const response = await fetch(`${base}?${query}&version=${number}`, { cache: 'no-store' });
    if (!response.ok || editor === null) return;
    const old = (await response.json()) as { content: Record<string, unknown> };
    setComparison({
      version: number,
      content: old.content,
      parts: diffWords(textOf(old.content), textOf(editor.getJSON())),
    });
  };

  const restore = async () => {
    if (comparison === null || editor === null) return;
    editor.commands.setContent(comparison.content);
    dirty.current = true;
    await save('manual');
    setComparison(null);
    setPanel('none');
  };

  const download = async (format: (typeof EXPORT_FORMATS)[number]) => {
    setExporting(format);
    setExportNotice(null);
    try {
      if (dirty.current) await save('manual');
      const response = await fetch(`${base}/export?${query}&format=${format}`);
      if (!response.ok) {
        setExportNotice({ ok: false, warnings: [] });
        return;
      }
      const warnings = (response.headers.get('X-Bahith-Export-Warnings') ?? '')
        .split(',')
        .filter((entry) => entry !== '')
        .map((entry) => entry.split(':')[0] ?? '');
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const encoded = /filename\*=UTF-8''([^;]+)/u.exec(disposition)?.[1];
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = encoded === undefined ? `draft.${format}` : decodeURIComponent(encoded);
      anchor.click();
      URL.revokeObjectURL(url);
      setExportNotice({ ok: true, warnings });
    } catch {
      setExportNotice({ ok: false, warnings: [] });
    } finally {
      setExporting(null);
    }
  };

  const tool = (label: string, pressed: boolean, action: () => void) => (
    <button
      type="button"
      className={`tool-button${pressed ? ' is-active' : ''}`}
      aria-pressed={pressed}
      disabled={!props.canWrite || editor === null}
      onClick={action}
    >
      {label}
    </button>
  );

  return (
    <main className="app-shell mx-auto min-h-dvh w-full max-w-5xl space-y-5 px-5 py-7 sm:px-8">
      <nav aria-label={t('breadcrumb')} className="text-sm">
        <Link
          href={`/workspaces/${props.workspaceId}/projects/${props.projectId}`}
          className="underline underline-offset-4"
        >
          {t('backToProject')}
        </Link>
      </nav>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <p className="muted text-sm">{t('kicker')}</p>
          <h1 className="break-words text-3xl font-bold" dir="auto">
            {props.title}
          </h1>
        </div>
        <p className="muted text-sm" role="status" data-testid="save-state">
          {t(`save.${saveState}`)}
        </p>
      </header>

      {saveState === 'conflict' ? (
        <p className="error-text" role="alert">
          {t('conflict')}
        </p>
      ) : null}

      {props.canWrite ? (
        <div className="surface flex flex-wrap gap-2 p-3" role="toolbar" aria-label={t('toolbar')}>
          {tool(t('chapter'), active?.h1 ?? false, () =>
            editor?.chain().focus().toggleHeading({ level: 1 }).run(),
          )}
          {tool(t('section'), active?.h2 ?? false, () =>
            editor?.chain().focus().toggleHeading({ level: 2 }).run(),
          )}
          {tool(t('subsection'), active?.h3 ?? false, () =>
            editor?.chain().focus().toggleHeading({ level: 3 }).run(),
          )}
          {tool(t('bold'), active?.bold ?? false, () => editor?.chain().focus().toggleBold().run())}
          {tool(t('italic'), active?.italic ?? false, () =>
            editor?.chain().focus().toggleItalic().run(),
          )}
          {tool(t('bulletList'), active?.bullet ?? false, () =>
            editor?.chain().focus().toggleBulletList().run(),
          )}
          {tool(t('orderedList'), active?.ordered ?? false, () =>
            editor?.chain().focus().toggleOrderedList().run(),
          )}
          {tool(t('quote'), active?.quote ?? false, () =>
            editor?.chain().focus().toggleBlockquote().run(),
          )}
          {tool(t('table'), false, () =>
            editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
          )}
          {tool(t('rtl'), false, () => editor?.chain().focus().setTextDirection('rtl').run())}
          {tool(t('ltr'), false, () => editor?.chain().focus().setTextDirection('ltr').run())}
          {tool(t('footnote'), panel === 'footnote', () => {
            setPanel(panel === 'footnote' ? 'none' : 'footnote');
          })}
          {tool(t('cite'), panel === 'cite', () => {
            setPanel(panel === 'cite' ? 'none' : 'cite');
          })}
          <button type="button" className="tool-button" onClick={() => void save('manual')}>
            {t('saveVersion')}
          </button>
        </div>
      ) : (
        <p className="muted">{t('readOnly')}</p>
      )}

      {panel === 'footnote' ? (
        <form className="surface flex flex-wrap gap-3 p-4" onSubmit={insertFootnote}>
          <label className="sr-only" htmlFor="footnote-text">
            {t('footnoteText')}
          </label>
          <input
            id="footnote-text"
            name="footnote"
            className="field min-w-0 flex-1"
            dir="auto"
            maxLength={4000}
            required
            placeholder={t('footnoteText')}
          />
          <button type="submit" className="btn">
            {t('insertFootnote')}
          </button>
        </form>
      ) : null}

      {panel === 'cite' ? (
        <section className="surface space-y-3 p-4" aria-labelledby="cite-title">
          <h2 id="cite-title" className="section-title">
            {t('citeTitle')}
          </h2>
          <p className="muted text-sm">{t('citeHint')}</p>
          <form
            className="flex flex-wrap gap-3"
            role="search"
            onSubmit={(event) => void searchEvidence(event)}
          >
            <label className="sr-only" htmlFor="cite-query">
              {t('citeSearch')}
            </label>
            <input
              id="cite-query"
              name="query"
              className="field min-w-0 flex-1"
              dir="auto"
              required
              placeholder={t('citeSearch')}
            />
            <button type="submit" className="btn">
              {t('search')}
            </button>
          </form>
          {evidence === null ? null : evidence.length === 0 ? (
            <p>{t('noEvidence')}</p>
          ) : (
            <ul className="space-y-2">
              {evidence.map((item) => (
                <li key={item.chunkId} className="rounded-xl border border-border p-3">
                  <p className="font-serif leading-loose" dir="auto">
                    {item.content}
                  </p>
                  <div className="muted mt-2 flex flex-wrap items-center gap-3 text-sm">
                    <span dir="auto">{item.sourceTitle}</span>
                    <span>
                      {item.pageStart === null ? t('noPage') : t('page', { page: item.pageStart })}
                    </span>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        insertCitation(item);
                      }}
                    >
                      {t('insertCitation')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="surface draft-surface p-5 sm:p-8" aria-label={t('editorLabel')}>
        <EditorContent editor={editor} />
      </section>

      <section className="surface space-y-3 p-4" aria-labelledby="export-title">
        <h2 id="export-title" className="section-title">
          {t('exportTitle')}
        </h2>
        <p className="muted text-sm">{t('exportHint')}</p>
        <div className="flex flex-wrap gap-2">
          {EXPORT_FORMATS.map((format) => (
            <button
              key={format}
              type="button"
              className="btn-secondary"
              disabled={exporting !== null}
              onClick={() => void download(format)}
            >
              {t(`export.${format}`)}
            </button>
          ))}
          <button
            type="button"
            className="btn-secondary"
            aria-expanded={panel === 'versions'}
            onClick={() => void openVersions()}
          >
            {t('versions')}
          </button>
        </div>
        {exportNotice === null ? null : exportNotice.ok ? (
          <div role="status" className="space-y-1 text-sm">
            <p className="success-text">{t('exported')}</p>
            {exportNotice.warnings.map((code) => (
              <p key={code} className="muted" data-testid="export-warning">
                {isKnownWarning(code) ? t(`warning.${code}`) : t('warning.OTHER', { code })}
              </p>
            ))}
          </div>
        ) : (
          <p className="error-text" role="alert">
            {t('exportFailed')}
          </p>
        )}
      </section>

      {panel === 'versions' ? (
        <section className="surface space-y-3 p-4" aria-labelledby="versions-title">
          <h2 id="versions-title" className="section-title">
            {t('versions')}
          </h2>
          <ol className="space-y-1 text-sm">
            {versions.map((item) => (
              <li key={item.version} className="flex flex-wrap items-center gap-3">
                <span>{t('versionLabel', { version: item.version })}</span>
                <span className="muted">{t(`kind.${item.kind}`)}</span>
                <time className="muted" dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString()}
                </time>
                <button
                  type="button"
                  className="underline underline-offset-4"
                  onClick={() => void compareWith(item.version)}
                >
                  {t('compare')}
                </button>
              </li>
            ))}
          </ol>
          {comparison === null ? null : (
            <div className="space-y-3">
              <p className="muted text-sm">{t('comparing', { version: comparison.version })}</p>
              <div
                className="rounded-xl border border-border p-3 leading-loose whitespace-pre-wrap"
                dir="auto"
                data-testid="version-diff"
              >
                {comparison.parts.map((part, index) =>
                  part.added ? (
                    <ins key={index} className="diff-added">
                      {part.value}
                    </ins>
                  ) : part.removed ? (
                    <del key={index} className="diff-removed">
                      {part.value}
                    </del>
                  ) : (
                    <span key={index}>{part.value}</span>
                  ),
                )}
              </div>
              {props.canWrite ? (
                <button type="button" className="btn-secondary" onClick={() => void restore()}>
                  {t('restore', { version: comparison.version })}
                </button>
              ) : null}
            </div>
          )}
        </section>
      ) : null}
    </main>
  );
}
