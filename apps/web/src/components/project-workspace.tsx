'use client';

import type { DocumentSummary, LibraryEntry, SourceMetadata } from '@bahith/db';
import { useLocale, useTranslations } from 'next-intl';
import type { SubmitEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AssistantPanel } from '@/components/assistant-panel';
import { FilePicker } from '@/components/file-picker';
import { NotificationBell } from '@/components/notification-bell';
import { ReferencesPanel } from '@/components/references-panel';
import { Link, useRouter } from '@/i18n/navigation';

interface ProjectInfo {
  id: string;
  workspaceId: string;
  title: string;
  researchQuestion: string | null;
  canWrite: boolean;
}

interface Evidence {
  chunkId: string;
  fileId: string | null;
  sourceId: string;
  sourceTitle: string;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  provenance: { extractionMethod?: 'text' | 'ocr'; ocrConfidence?: number | null } | null;
}

interface RetrieveResponse {
  mode: 'lexical' | 'hybrid';
  results: Evidence[];
}

const UPLOAD_ERRORS = {
  UPLOAD_TOO_LARGE: 'uploadTooLarge',
  UPLOAD_UNSUPPORTED_TYPE: 'uploadUnsupported',
  UPLOAD_MISSING: 'uploadMissing',
  STORAGE_NOT_CONFIGURED: 'storageUnavailable',
  STORAGE_UNAVAILABLE: 'storageUnavailable',
} as const;

const STATUS_KEYS = {
  uploaded: 'statusQueued',
  processing: 'statusProcessing',
  ready: 'statusReady',
  failed: 'statusFailed',
} as const;

function isStatus(value: string): value is keyof typeof STATUS_KEYS {
  return value in STATUS_KEYS;
}

function errorKey(
  code: unknown,
): (typeof UPLOAD_ERRORS)[keyof typeof UPLOAD_ERRORS] | 'uploadFailed' {
  return typeof code === 'string' && code in UPLOAD_ERRORS
    ? UPLOAD_ERRORS[code as keyof typeof UPLOAD_ERRORS]
    : 'uploadFailed';
}

export function ProjectWorkspace({
  project,
  initialLibrary,
  drafts,
  references,
  assistant,
  unreadNotifications,
}: {
  project: ProjectInfo;
  initialLibrary: LibraryEntry[];
  drafts: DocumentSummary[];
  references: SourceMetadata[];
  assistant: { consent: boolean; model: string | null };
  unreadNotifications: number;
}) {
  const t = useTranslations('Project');
  const locale = useLocale();
  const router = useRouter();
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [draftError, setDraftError] = useState(false);
  const [library, setLibrary] = useState(initialLibrary);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<RetrieveResponse | null>(null);
  const [searchError, setSearchError] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const query = `workspaceId=${project.workspaceId}`;
  const base = `/api/projects/${project.id}`;

  const refresh = useCallback(async () => {
    const response = await fetch(`${base}/sources?${query}`, { cache: 'no-store' });
    if (response.ok) {
      const body = (await response.json()) as { sources: LibraryEntry[] };
      setLibrary(body.sources);
    }
  }, [base, query]);

  const pending = library.some((entry) =>
    entry.files.some((file) => file.status === 'uploaded' || file.status === 'processing'),
  );
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void refresh(), 2500);
    return () => {
      clearInterval(timer);
    };
  }, [pending, refresh]);

  const titles = new Map(library.map((entry) => [entry.sourceId, entry.title]));

  const upload = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    // React clears currentTarget once the handler awaits; keep the form now.
    const form = event.currentTarget;
    const file = fileInput.current?.files?.[0];
    if (file === undefined) {
      setNotice({ kind: 'error', text: t('uploadMissing') });
      return;
    }
    setUploading(true);
    setNotice(null);
    try {
      const body = new FormData();
      body.set('file', file);
      const response = await fetch(`${base}/sources?${query}`, { method: 'POST', body });
      const payload = (await response.json().catch(() => ({}))) as {
        code?: string;
        upload?: { duplicate: boolean };
      };
      if (!response.ok) {
        setNotice({ kind: 'error', text: t(errorKey(payload.code)) });
      } else {
        setNotice({
          kind: 'success',
          text: payload.upload?.duplicate === true ? t('uploadDuplicate') : t('uploadAccepted'),
        });
        form.reset();
        await refresh();
      }
    } catch {
      setNotice({ kind: 'error', text: t('uploadFailed') });
    } finally {
      setUploading(false);
    }
  };

  const search = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get('query');
    if (typeof text !== 'string' || text.trim() === '') return;
    setSearching(true);
    setSearchError(false);
    try {
      const response = await fetch('/api/sanad/retrieve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: project.workspaceId,
          projectId: project.id,
          query: text.trim(),
          limit: 10,
        }),
      });
      if (!response.ok) setSearchError(true);
      else setResults((await response.json()) as RetrieveResponse);
    } catch {
      setSearchError(true);
    } finally {
      setSearching(false);
    }
  };

  const createDraft = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = new FormData(event.currentTarget).get('title');
    if (typeof title !== 'string' || title.trim() === '') return;
    setCreatingDraft(true);
    setDraftError(false);
    try {
      const response = await fetch(`${base}/documents?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() }),
      });
      if (!response.ok) {
        setDraftError(true);
        return;
      }
      const { document } = (await response.json()) as { document: { id: string } };
      router.push(
        `/workspaces/${project.workspaceId}/projects/${project.id}/documents/${document.id}`,
      );
    } catch {
      setDraftError(true);
    } finally {
      setCreatingDraft(false);
    }
  };

  const fileUrl = (fileId: string, page: number | null) =>
    `${base}/files/${fileId}?${query}${page === null ? '' : `#page=${page}`}`;

  return (
    <main className="app-shell mx-auto min-h-dvh w-full max-w-6xl space-y-8 px-5 py-7 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <nav aria-label={t('breadcrumb')} className="text-sm">
          <Link href="/dashboard" className="underline underline-offset-4">
            {t('backToDashboard')}
          </Link>
        </nav>
        <NotificationBell count={unreadNotifications} />
      </div>
      <header className="space-y-3">
        <p className="muted text-sm">{t('kicker')}</p>
        <h1 className="break-words text-3xl font-bold sm:text-4xl" dir="auto">
          {project.title}
        </h1>
        <p className="muted max-w-3xl leading-relaxed" dir="auto">
          {project.researchQuestion === null || project.researchQuestion === ''
            ? t('questionMissing')
            : project.researchQuestion}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section className="surface space-y-5 p-5 sm:p-6" aria-labelledby="library-title">
          <div className="space-y-1">
            <h2 className="section-title" id="library-title">
              {t('libraryTitle')}
            </h2>
            <p className="muted text-sm leading-relaxed">{t('libraryDescription')}</p>
          </div>

          {project.canWrite ? (
            <form method="post" className="space-y-3" onSubmit={(event) => void upload(event)}>
              <label className="block space-y-2" htmlFor="source-file">
                <span className="font-medium">{t('uploadLabel')}</span>
              </label>
              <FilePicker
                id="source-file"
                inputRef={fileInput}
                name="file"
                accept=".pdf,.docx,.txt,.png,.jpg,.jpeg,.tif,.tiff,application/pdf,text/plain,image/png,image/jpeg,image/tiff,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                aria-describedby="source-file-hint"
                required
              />
              <p id="source-file-hint" className="muted text-sm">
                {t('uploadHint')}
              </p>
              <button className="btn" type="submit" disabled={uploading}>
                {t(uploading ? 'uploading' : 'upload')}
              </button>
            </form>
          ) : (
            <p className="muted text-sm">{t('readOnly')}</p>
          )}

          {notice === null ? null : (
            <p
              className={notice.kind === 'error' ? 'error-text' : 'success-text'}
              role={notice.kind === 'error' ? 'alert' : 'status'}
            >
              {notice.text}
            </p>
          )}

          {library.length === 0 ? (
            <p className="muted">{t('libraryEmpty')}</p>
          ) : (
            <ul className="space-y-3" aria-live="polite" aria-label={t('libraryTitle')}>
              {library.map((entry) => (
                <li key={entry.sourceId} className="rounded-xl border border-border p-4">
                  <p className="break-words font-semibold" dir="auto">
                    {entry.title}
                  </p>
                  {entry.files.map((file) => (
                    <div
                      key={file.id}
                      className="muted mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
                    >
                      <span data-testid="file-status">
                        {isStatus(file.status) ? t(STATUS_KEYS[file.status]) : file.status}
                      </span>
                      {file.pageCount === null ? null : (
                        <span>{t('pages', { count: file.pageCount })}</span>
                      )}
                      {file.status === 'ready' ? (
                        <span>{t('passages', { count: file.chunkCount })}</span>
                      ) : null}
                      {file.ocrUsed ? <span className="font-medium">{t('ocrUsed')}</span> : null}
                      {file.failureCount > 0 ? (
                        <span>{t('pageFailures', { count: file.failureCount })}</span>
                      ) : null}
                      {file.status === 'failed' && file.errorCode !== null ? (
                        <span>{t('failureCode', { code: file.errorCode })}</span>
                      ) : null}
                      <a
                        className="underline underline-offset-4"
                        href={fileUrl(file.id, null)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t('openFile')}
                      </a>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="surface space-y-5 p-5 sm:p-6" aria-labelledby="evidence-title">
          <div className="space-y-1">
            <h2 className="section-title" id="evidence-title">
              {t('evidenceTitle')}
            </h2>
            <p className="muted text-sm leading-relaxed">{t('evidenceDescription')}</p>
          </div>
          <form
            method="post"
            className="flex flex-wrap gap-3"
            role="search"
            onSubmit={(event) => void search(event)}
          >
            <label className="sr-only" htmlFor="evidence-query">
              {t('searchLabel')}
            </label>
            <input
              id="evidence-query"
              name="query"
              className="field min-w-0 flex-1"
              dir="auto"
              maxLength={2000}
              required
              placeholder={t('searchPlaceholder')}
            />
            <button className="btn" type="submit" disabled={searching}>
              {t(searching ? 'searching' : 'search')}
            </button>
          </form>
          {searchError ? (
            <p className="error-text" role="alert">
              {t('searchFailed')}
            </p>
          ) : null}
          {results === null ? null : (
            <div className="space-y-3" aria-live="polite">
              <p className="muted text-sm">
                {t(results.mode === 'lexical' ? 'modeLexical' : 'modeHybrid')}
              </p>
              {results.results.length === 0 ? (
                <p>{t('noEvidence')}</p>
              ) : (
                <ol className="space-y-3">
                  {results.results.map((item) => (
                    <li
                      key={item.chunkId}
                      className="rounded-xl border border-border p-4"
                      data-testid="evidence"
                    >
                      <p className="break-words font-serif leading-loose" dir="auto">
                        {item.content}
                      </p>
                      <div className="muted mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                        <span dir="auto">{titles.get(item.sourceId) ?? item.sourceTitle}</span>
                        <span data-testid="evidence-page">
                          {item.pageStart === null
                            ? t('noPage')
                            : item.pageEnd !== null && item.pageEnd !== item.pageStart
                              ? t('pageRange', { start: item.pageStart, end: item.pageEnd })
                              : t('page', { page: item.pageStart })}
                        </span>
                        {item.provenance?.extractionMethod === 'ocr' ? (
                          <span className="font-medium">{t('ocrEvidence')}</span>
                        ) : null}
                        {item.fileId === null ? null : (
                          <a
                            className="underline underline-offset-4"
                            href={fileUrl(item.fileId, item.pageStart)}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {t(item.pageStart === null ? 'openSource' : 'openAtPage')}
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </section>
      </div>

      <AssistantPanel
        projectId={project.id}
        workspaceId={project.workspaceId}
        canWrite={project.canWrite}
        language={locale === 'en' ? 'en' : 'ar'}
        initialConsent={assistant.consent}
        model={assistant.model}
      />

      <ReferencesPanel
        projectId={project.id}
        workspaceId={project.workspaceId}
        canWrite={project.canWrite}
        initialReferences={references}
      />

      <section className="surface space-y-4 p-5 sm:p-6" aria-labelledby="drafts-title">
        <div className="space-y-1">
          <h2 className="section-title" id="drafts-title">
            {t('draftsTitle')}
          </h2>
          <p className="muted text-sm">{t('draftsDescription')}</p>
        </div>
        {project.canWrite ? (
          <form
            method="post"
            className="flex flex-wrap gap-3"
            onSubmit={(event) => void createDraft(event)}
          >
            <label className="sr-only" htmlFor="draft-title">
              {t('draftTitle')}
            </label>
            <input
              id="draft-title"
              name="title"
              className="field min-w-0 flex-1"
              dir="auto"
              maxLength={300}
              required
              placeholder={t('draftTitle')}
            />
            <button className="btn" type="submit" disabled={creatingDraft}>
              {t(creatingDraft ? 'creatingDraft' : 'createDraft')}
            </button>
          </form>
        ) : null}
        {draftError ? (
          <p className="error-text" role="alert">
            {t('draftCreateFailed')}
          </p>
        ) : null}
        {drafts.length === 0 ? (
          <p className="muted">{t('draftsEmpty')}</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {drafts.map((draft) => (
              <li key={draft.id} className="rounded-xl border border-border p-4">
                <p className="break-words font-semibold" dir="auto">
                  {draft.title}
                </p>
                <p className="muted text-sm">
                  {t('draftVersion', { version: draft.latestVersion })}
                </p>
                <Link
                  className="underline underline-offset-4"
                  href={`/workspaces/${project.workspaceId}/projects/${project.id}/documents/${draft.id}`}
                >
                  {t('openDraft')}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
