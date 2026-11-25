'use client';

import type { SourceMetadata } from '@bahith/db';
import { useLocale, useTranslations } from 'next-intl';
import type { SubmitEvent } from 'react';
import { useCallback, useState } from 'react';

import { FilePicker } from '@/components/file-picker';
import { ZoteroImport } from '@/components/zotero-import';

const ERROR_KEYS = {
  SCHOLARLY_NOT_CONFIGURED: 'errorNotConfigured',
  VERIFICATION_UNAVAILABLE: 'errorUnavailable',
  REGISTRY_UNAVAILABLE: 'errorUnavailable',
  DOI_MALFORMED: 'errorDoiMalformed',
  DOI_NOT_FOUND: 'errorDoiNotFound',
  VERIFICATION_NEEDS_DOI_OR_TITLE: 'errorNeedsDoiOrTitle',
  IMPORT_UNREADABLE: 'errorImportUnreadable',
  IMPORT_MISSING: 'errorImportMissing',
  IMPORT_TOO_LARGE: 'errorImportMissing',
  IMPORT_NOT_UTF8: 'errorImportNotUtf8',
} as const;

function errorKey(code: unknown): (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS] | 'errorGeneric' {
  return typeof code === 'string' && code in ERROR_KEYS
    ? ERROR_KEYS[code as keyof typeof ERROR_KEYS]
    : 'errorGeneric';
}

const RESULT_KEYS = {
  verified: 'resultVerified',
  mismatch: 'resultMismatch',
  not_found: 'resultNotFound',
} as const;

function authorLine(reference: SourceMetadata, locale: string): string {
  return new Intl.ListFormat(locale, { style: 'short', type: 'unit' }).format(
    reference.authors.map(
      (author) => author.literal ?? [author.given, author.family].filter(Boolean).join(' '),
    ),
  );
}

/**
 * The project's references: add by DOI, import/export BibTeX and RIS, and verification
 * against Crossref/OpenAlex. Verification status always comes from the server.
 */
export function ReferencesPanel({
  projectId,
  workspaceId,
  canWrite,
  initialReferences,
}: {
  projectId: string;
  workspaceId: string;
  canWrite: boolean;
  initialReferences: SourceMetadata[];
}) {
  const t = useTranslations('References');
  const locale = useLocale();
  const [references, setReferences] = useState(initialReferences);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const query = `workspaceId=${workspaceId}`;
  const base = `/api/projects/${projectId}/references`;

  const refresh = useCallback(async () => {
    const response = await fetch(`${base}?${query}`, { cache: 'no-store' });
    if (response.ok) {
      setReferences(((await response.json()) as { references: SourceMetadata[] }).references);
    }
  }, [base, query]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setNotice(null);
    try {
      await action();
    } catch {
      setNotice({ kind: 'error', text: t('errorGeneric') });
    } finally {
      setBusy(null);
    }
  };

  const addDoi = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const doi = new FormData(form).get('doi');
    if (typeof doi !== 'string' || doi.trim() === '') return;
    void run('doi', async () => {
      const response = await fetch(`${base}?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doi }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        code?: string;
        reference?: { duplicate: boolean };
        provider?: string;
      };
      if (!response.ok) {
        setNotice({ kind: 'error', text: t(errorKey(payload.code)) });
        return;
      }
      setNotice({
        kind: 'success',
        text:
          payload.reference?.duplicate === true
            ? t('alreadyAdded')
            : t('added', { provider: payload.provider === 'openalex' ? 'OpenAlex' : 'Crossref' }),
      });
      form.reset();
      await refresh();
    });
  };

  const importFile = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get('file');
    if (!(file instanceof File) || file.size === 0) {
      setNotice({ kind: 'error', text: t('errorImportMissing') });
      return;
    }
    void run('import', async () => {
      const body = new FormData();
      body.set('file', file);
      const response = await fetch(`${base}/import?${query}`, { method: 'POST', body });
      const payload = (await response.json().catch(() => ({}))) as {
        code?: string;
        added?: number;
        duplicates?: number;
        skipped?: number;
      };
      if (!response.ok) {
        setNotice({ kind: 'error', text: t(errorKey(payload.code)) });
        return;
      }
      setNotice({
        kind: 'success',
        text: t('imported', {
          added: payload.added ?? 0,
          duplicates: payload.duplicates ?? 0,
          skipped: payload.skipped ?? 0,
        }),
      });
      form.reset();
      await refresh();
    });
  };

  const verify = (sourceId: string) => {
    void run(sourceId, async () => {
      const response = await fetch(
        `/api/projects/${projectId}/sources/${sourceId}/verify?${query}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        code?: string;
        status?: string;
      };
      if (!response.ok) {
        setNotice({ kind: 'error', text: t(errorKey(payload.code)) });
        return;
      }
      const status = payload.status;
      setNotice({
        kind: status === 'verified' ? 'success' : 'error',
        text:
          status !== undefined && status in RESULT_KEYS
            ? t(RESULT_KEYS[status as keyof typeof RESULT_KEYS])
            : t('errorGeneric'),
      });
      await refresh();
    });
  };

  const statusLabel = (reference: SourceMetadata) => {
    switch (reference.verificationStatus) {
      case 'verified':
        return t('statusVerified', { provider: reference.verificationProvider ?? '' });
      case 'mismatch':
        return t('statusMismatch');
      case 'not_found':
        return t('statusNotFound');
      default:
        return t('statusUnverified');
    }
  };

  return (
    <section className="surface space-y-5 p-5 sm:p-6" aria-labelledby="references-title">
      <div className="space-y-1">
        <h2 className="section-title" id="references-title">
          {t('title')}
        </h2>
        <p className="muted text-sm leading-relaxed">{t('description')}</p>
      </div>

      {canWrite ? (
        <div className="grid gap-4 md:grid-cols-2">
          <form method="post" className="space-y-2" onSubmit={addDoi}>
            <label className="block text-sm font-medium" htmlFor="reference-doi">
              {t('doiLabel')}
            </label>
            <div className="flex gap-2">
              <input
                id="reference-doi"
                name="doi"
                className="field min-w-0 flex-1"
                dir="ltr"
                maxLength={300}
                placeholder={t('doiPlaceholder')}
                required
              />
              <button className="btn" type="submit" disabled={busy !== null}>
                {t(busy === 'doi' ? 'adding' : 'addDoi')}
              </button>
            </div>
          </form>
          <form method="post" className="space-y-2" onSubmit={importFile}>
            <label className="block text-sm font-medium" htmlFor="reference-import">
              {t('importLabel')}
            </label>
            <div className="flex gap-2">
              <FilePicker
                id="reference-import"
                name="file"
                accept=".bib,.ris,.txt,.json,application/json,application/x-bibtex,application/x-research-info-systems"
              />
              <button className="btn" type="submit" disabled={busy !== null}>
                {t(busy === 'import' ? 'importing' : 'import')}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {canWrite ? (
        <ZoteroImport projectId={projectId} workspaceId={workspaceId} onImported={refresh} />
      ) : null}

      <div className="flex flex-wrap gap-3 text-sm">
        <a className="underline underline-offset-4" href={`${base}/export?${query}&format=bibtex`}>
          {t('exportBibtex')}
        </a>
        <a className="underline underline-offset-4" href={`${base}/export?${query}&format=ris`}>
          {t('exportRis')}
        </a>
      </div>

      {notice === null ? null : (
        <p
          className={notice.kind === 'error' ? 'error-text' : 'text-sm'}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}

      {references.length === 0 ? (
        <p className="muted">{t('empty')}</p>
      ) : (
        <ul className="space-y-3" aria-label={t('title')}>
          {references.map((reference) => (
            <li
              key={reference.sourceId}
              className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-4"
              data-verification={reference.verificationStatus}
            >
              <div className="min-w-0 space-y-1">
                <p className="break-words font-semibold" dir="auto">
                  {reference.title}
                </p>
                <p className="muted text-sm" dir="auto">
                  {[
                    authorLine(reference, locale),
                    reference.year ?? t('noYear'),
                    reference.containerTitle,
                  ]
                    .filter((part) => part !== null && part !== '')
                    .join(' · ')}
                </p>
                {reference.doi === null ? null : (
                  <p className="muted text-xs" dir="ltr">
                    {reference.doi}
                  </p>
                )}
                <p className="text-sm font-medium">{statusLabel(reference)}</p>
              </div>
              {canWrite ? (
                <button
                  className="btn-secondary"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    verify(reference.sourceId);
                  }}
                  aria-label={`${t('verify')}: ${reference.title}`}
                >
                  {t(busy === reference.sourceId ? 'verifying' : 'verify')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
