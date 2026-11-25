'use client';

import { useTranslations } from 'next-intl';
import type { SubmitEvent } from 'react';
import { useState } from 'react';

type ErrorKey =
  'errorInvalid' | 'errorKeyRejected' | 'errorNotFound' | 'errorRateLimited' | 'errorTimeout';

const ERROR_KEYS: Record<string, ErrorKey> = {
  ZOTERO_INVALID_CREDENTIALS: 'errorInvalid',
  ZOTERO_KEY_REJECTED: 'errorKeyRejected',
  ZOTERO_LIBRARY_NOT_FOUND: 'errorNotFound',
  ZOTERO_RATE_LIMITED: 'errorRateLimited',
  ZOTERO_TIMEOUT: 'errorTimeout',
};

/**
 * One-off import of a Zotero library through the Web API. The user ID and key are sent
 * once with the request and never stored (the form is cleared afterwards).
 */
export function ZoteroImport({
  projectId,
  workspaceId,
  onImported,
}: {
  projectId: string;
  workspaceId: string;
  onImported: () => Promise<void>;
}) {
  const t = useTranslations('Zotero');
  const r = useTranslations('References');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/references/zotero?workspaceId=${workspaceId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: data.get('userId'), apiKey: data.get('apiKey') }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        code?: string;
        added?: number;
        duplicates?: number;
        skipped?: number;
        truncated?: boolean;
      };
      if (!response.ok) {
        setNotice({ kind: 'error', text: t(ERROR_KEYS[payload.code ?? ''] ?? 'errorUnavailable') });
        return;
      }
      form.reset();
      const summary = r('imported', {
        added: payload.added ?? 0,
        duplicates: payload.duplicates ?? 0,
        skipped: payload.skipped ?? 0,
      });
      setNotice({
        kind: 'success',
        text: payload.truncated === true ? `${summary} ${t('truncated')}` : summary,
      });
      await onImported();
    } catch {
      setNotice({ kind: 'error', text: t('errorUnavailable') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      method="post"
      className="space-y-3 rounded-xl border border-border p-4"
      onSubmit={(event) => void submit(event)}
      data-testid="zotero-import"
      autoComplete="off"
    >
      <h3 className="font-semibold">{t('title')}</h3>
      <p className="muted text-sm">{t('description')}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label className="block text-sm font-medium" htmlFor="zotero-user">
            {t('userIdLabel')}
          </label>
          <input
            id="zotero-user"
            name="userId"
            className="field"
            dir="ltr"
            inputMode="numeric"
            maxLength={12}
            required
          />
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-medium" htmlFor="zotero-key">
            {t('apiKeyLabel')}
          </label>
          <input
            id="zotero-key"
            name="apiKey"
            type="password"
            className="field"
            dir="ltr"
            maxLength={64}
            autoComplete="off"
            required
          />
        </div>
      </div>
      <p className="muted text-sm">{t('keysHint')}</p>
      <button className="btn-secondary" type="submit" disabled={busy}>
        {t(busy ? 'importing' : 'import')}
      </button>
      <p className="muted text-sm">{t('fileHint')}</p>
      {notice === null ? null : (
        <p
          className={notice.kind === 'error' ? 'error-text text-sm' : 'text-sm'}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}
    </form>
  );
}
