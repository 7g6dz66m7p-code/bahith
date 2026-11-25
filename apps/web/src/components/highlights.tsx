'use client';

import type { HighlightColor, HighlightEntry } from '@bahith/db';
import { useTranslations } from 'next-intl';
import type { ReactNode, SubmitEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import type { PassageSpan } from '@/lib/highlight-span';
import { selectionSpan, wholePassage } from '@/lib/highlight-span';

const COLORS: readonly HighlightColor[] = ['yellow', 'green', 'blue', 'pink'];

/** The span of the current selection when it lies inside `element` (one text node). */
function spanInside(element: HTMLElement, content: string): PassageSpan | null {
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) {
    return null;
  }
  const before = document.createRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  return selectionSpan(content, before.toString().length, range.toString());
}

/**
 * A SANAD evidence passage that owners and editors can highlight: the whole passage or a
 * selected span, with an optional note and colour. Offsets are sent in code points and the
 * server checks the quote against the stored passage, so a highlight never misquotes.
 */
export function HighlightablePassage({
  chunkId,
  content,
  canWrite,
  projectId,
  workspaceId,
  onSaved,
  children,
}: {
  chunkId: string;
  content: string;
  canWrite: boolean;
  projectId: string;
  workspaceId: string;
  onSaved: () => void;
  children?: ReactNode;
}) {
  const t = useTranslations('Highlights');
  const passage = useRef<HTMLParagraphElement>(null);
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<PassageSpan | null>(null);
  const [scope, setScope] = useState<'whole' | 'selection'>('whole');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    if (!canWrite) return;
    const onSelectionChange = () => {
      const element = passage.current;
      if (element === null) return;
      // Keep the last selection made inside the passage: clicking the form clears it.
      const span = spanInside(element, content);
      if (span !== null) {
        setSelected(span);
        setScope('selection');
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [canWrite, content]);

  const save = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const span = scope === 'selection' && selected !== null ? selected : wholePassage(content);
    const note = data.get('note');
    const color = data.get('color');
    setSaving(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/highlights?workspaceId=${workspaceId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chunkId,
            ...span,
            note: typeof note === 'string' ? note : null,
            color: typeof color === 'string' ? color : 'yellow',
          }),
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { code?: string };
        setNotice({
          kind: 'error',
          text: t(payload.code === 'HIGHLIGHT_QUOTE_MISMATCH' ? 'quoteMismatch' : 'error'),
        });
        return;
      }
      setNotice({ kind: 'success', text: t('saved') });
      form.reset();
      setOpen(false);
      setSelected(null);
      setScope('whole');
      onSaved();
    } catch {
      setNotice({ kind: 'error', text: t('error') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <p ref={passage} className="break-words font-serif leading-loose" dir="auto">
        {content}
      </p>
      {children}
      {canWrite ? (
        <div className="mt-3 space-y-3">
          <button
            type="button"
            className="btn-secondary"
            aria-expanded={open}
            aria-controls={formId}
            aria-label={t('openLabel')}
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            {t('open')}
          </button>
          {open ? (
            <form
              method="post"
              id={formId}
              className="space-y-3"
              onSubmit={(event) => void save(event)}
            >
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium">{t('scopeLegend')}</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="scope"
                    value="whole"
                    checked={scope === 'whole'}
                    onChange={() => {
                      setScope('whole');
                    }}
                  />
                  {t('scopeWhole')}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="scope"
                    value="selection"
                    disabled={selected === null}
                    checked={scope === 'selection'}
                    onChange={() => {
                      setScope('selection');
                    }}
                  />
                  <span dir="auto">
                    {selected === null
                      ? t('selectHint')
                      : t('scopeSelection', { quote: selected.quote })}
                  </span>
                </label>
              </fieldset>
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor={`${formId}-note`}>
                  {t('noteLabel')}
                </label>
                <textarea
                  id={`${formId}-note`}
                  name="note"
                  className="field min-h-20"
                  dir="auto"
                  maxLength={5000}
                />
              </div>
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor={`${formId}-color`}>
                  {t('colorLabel')}
                </label>
                <select
                  id={`${formId}-color`}
                  name="color"
                  className="field max-w-xs"
                  defaultValue="yellow"
                >
                  {COLORS.map((color) => (
                    <option key={color} value={color}>
                      {t(`color.${color}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn" type="submit" disabled={saving}>
                  {t(saving ? 'saving' : 'save')}
                </button>
                <button
                  className="btn-secondary"
                  type="button"
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  {t('cancel')}
                </button>
              </div>
            </form>
          ) : null}
          {notice === null ? null : (
            <p
              className={notice.kind === 'error' ? 'error-text text-sm' : 'success-text text-sm'}
              role={notice.kind === 'error' ? 'alert' : 'status'}
            >
              {notice.text}
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}

/**
 * The project's highlights with their notes, newest first, filterable by source. Pages and
 * the "open at page" link come from the stored passage, never from the highlight.
 */
export function HighlightsPanel({
  projectId,
  workspaceId,
  canWrite,
  highlights,
  sourceFilter,
  onReload,
  sources,
}: {
  projectId: string;
  workspaceId: string;
  canWrite: boolean;
  highlights: HighlightEntry[];
  /** The source the list is filtered by ('' for all). */
  sourceFilter: string;
  /** Reloads the list for a filter; false when loading failed. */
  onReload: (sourceFilter: string) => Promise<boolean>;
  sources: { sourceId: string; title: string }[];
}) {
  const t = useTranslations('Highlights');
  const p = useTranslations('Project');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const base = `/api/projects/${projectId}/highlights`;
  const query = `workspaceId=${workspaceId}`;

  const load = async (filter: string) => {
    if (!(await onReload(filter))) setNotice({ kind: 'error', text: t('loadFailed') });
  };

  const change = async (url: string, init: RequestInit, success: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(url, init);
      if (!response.ok) {
        setNotice({ kind: 'error', text: t('error') });
        return false;
      }
      setNotice({ kind: 'success', text: success });
      await load(sourceFilter);
      return true;
    } catch {
      setNotice({ kind: 'error', text: t('error') });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async (event: SubmitEvent<HTMLFormElement>, highlightId: string) => {
    event.preventDefault();
    const note = new FormData(event.currentTarget).get('note');
    const ok = await change(
      `${base}/${highlightId}?${query}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: typeof note === 'string' ? note : null }),
      },
      t('noteSaved'),
    );
    if (ok) setEditing(null);
  };

  const fileUrl = (fileId: string, page: number | null) =>
    `/api/projects/${projectId}/files/${fileId}?${query}${page === null ? '' : `#page=${page}`}`;

  return (
    <section className="surface space-y-5 p-5 sm:p-6" aria-labelledby="highlights-title">
      <div className="space-y-1">
        <h2 className="section-title" id="highlights-title">
          {t('title')}
        </h2>
        <p className="muted text-sm leading-relaxed">{t('description')}</p>
        {canWrite ? null : <p className="muted text-sm">{t('readOnly')}</p>}
      </div>

      {sources.length === 0 ? null : (
        <div className="max-w-md space-y-1">
          <label className="block text-sm font-medium" htmlFor="highlight-source-filter">
            {t('filterLabel')}
          </label>
          <select
            id="highlight-source-filter"
            className="field"
            value={sourceFilter}
            onChange={(event) => {
              void load(event.target.value);
            }}
          >
            <option value="">{t('allSources')}</option>
            {sources.map((source) => (
              <option key={source.sourceId} value={source.sourceId}>
                {source.title}
              </option>
            ))}
          </select>
        </div>
      )}

      {notice === null ? null : (
        <p
          className={notice.kind === 'error' ? 'error-text text-sm' : 'success-text text-sm'}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}

      {highlights.length === 0 ? (
        <p className="muted">{t('empty')}</p>
      ) : (
        <ul className="space-y-3" aria-label={t('title')}>
          {highlights.map((item) => (
            <li
              key={item.id}
              className={`highlight-mark highlight-${item.color} rounded-xl border border-border p-4`}
              data-testid="highlight"
              data-color={item.color}
            >
              <blockquote className="break-words font-serif leading-loose" dir="auto">
                {item.quote}
              </blockquote>
              <div className="muted mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span dir="auto">{item.sourceTitle}</span>
                <span data-testid="highlight-page">
                  {item.pageStart === null
                    ? p('noPage')
                    : item.pageEnd !== null && item.pageEnd !== item.pageStart
                      ? p('pageRange', { start: item.pageStart, end: item.pageEnd })
                      : p('page', { page: item.pageStart })}
                </span>
                <span>{t(`color.${item.color}`)}</span>
                {item.fileId === null ? null : (
                  <a
                    className="underline underline-offset-4"
                    href={fileUrl(item.fileId, item.pageStart)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {p(item.pageStart === null ? 'openSource' : 'openAtPage')}
                  </a>
                )}
              </div>
              {editing === item.id ? (
                <form
                  method="post"
                  className="mt-3 space-y-2"
                  onSubmit={(event) => void saveNote(event, item.id)}
                >
                  <label className="block text-sm font-medium" htmlFor={`note-${item.id}`}>
                    {t('noteLabel')}
                  </label>
                  <textarea
                    id={`note-${item.id}`}
                    name="note"
                    className="field min-h-20"
                    dir="auto"
                    maxLength={5000}
                    defaultValue={item.note ?? ''}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button className="btn" type="submit" disabled={busy}>
                      {t('saveNote')}
                    </button>
                    <button
                      className="btn-secondary"
                      type="button"
                      onClick={() => {
                        setEditing(null);
                      }}
                    >
                      {t('cancel')}
                    </button>
                  </div>
                </form>
              ) : item.note === null ? null : (
                <div className="mt-3 text-sm">
                  <p className="font-medium">{t('noteHeading')}</p>
                  <p
                    className="whitespace-pre-wrap break-words"
                    dir="auto"
                    data-testid="highlight-note"
                  >
                    {item.note}
                  </p>
                </div>
              )}
              {editing === item.id || (!item.canEditNote && !item.canDelete) ? null : (
                <div className="mt-3 flex flex-wrap gap-2">
                  {item.canEditNote ? (
                    <button
                      className="btn-secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEditing(item.id);
                      }}
                    >
                      {t(item.note === null ? 'addNote' : 'editNote')}
                    </button>
                  ) : null}
                  {item.canDelete ? (
                    <button
                      className="btn-secondary"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void change(
                          `${base}/${item.id}?${query}`,
                          { method: 'DELETE' },
                          t('deleted'),
                        )
                      }
                    >
                      {t('delete')}
                    </button>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
