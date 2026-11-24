'use client';

import { useTranslations } from 'next-intl';
import type { SubmitEvent } from 'react';
import { useState } from 'react';

import type { ClaimCheckReply } from '@/server/assistant';

/** Model judgement of one claim against the project's passages; errors share the assistant's wording. */
export function ClaimCheck({
  projectId,
  workspaceId,
  errorText,
}: {
  projectId: string;
  workspaceId: string;
  errorText: (code: unknown) => string;
}) {
  const t = useTranslations('ClaimCheck');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<ClaimCheckReply | null>(null);

  const check = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const claim = new FormData(event.currentTarget).get('claim');
    if (typeof claim !== 'string' || claim.trim() === '') return;
    setBusy(true);
    setError(null);
    setReply(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/claims/verify?workspaceId=${workspaceId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claim }),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as Partial<ClaimCheckReply> & {
        code?: string;
      };
      if (!response.ok) setError(errorText(payload.code));
      else setReply(payload as ClaimCheckReply);
    } catch {
      setError(errorText(null));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-border pt-5" data-testid="claim-check">
      <h3 className="font-semibold">{t('title')}</h3>
      <p className="muted text-sm leading-relaxed">{t('description')}</p>
      <form method="post" className="space-y-3" onSubmit={(event) => void check(event)}>
        <label className="block text-sm font-medium" htmlFor="claim-text">
          {t('claimLabel')}
        </label>
        <textarea
          id="claim-text"
          name="claim"
          className="field min-h-20 w-full"
          dir="auto"
          maxLength={2000}
          required
        />
        <button className="btn" type="submit" disabled={busy}>
          {t(busy ? 'checking' : 'check')}
        </button>
      </form>
      {error === null ? null : (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {reply === null ? null : (
        <div className="space-y-3" aria-live="polite">
          {reply.judgements.length === 0 ? (
            <p role="status">{t('noPassages')}</p>
          ) : (
            <>
              {reply.conflict ? <p className="error-text font-medium">{t('conflict')}</p> : null}
              <p className="font-medium">{t('strength', { level: t(reply.strength) })}</p>
              <ul className="space-y-2">
                {reply.judgements.map((item) => (
                  <li
                    key={item.chunkId}
                    className="space-y-1 rounded-xl border border-border p-3 text-sm"
                  >
                    <p className="flex flex-wrap gap-x-3">
                      <span
                        className={`support-badge ${item.verdict === 'supports' ? 'support-supported' : item.verdict === 'contradicts' ? 'support-unsupported' : 'support-inference'}`}
                      >
                        {t(item.verdict)}
                      </span>
                      <span dir="auto" className="font-medium">
                        {item.sourceTitle}
                      </span>
                    </p>
                    {item.quote === '' ? null : (
                      <blockquote dir="auto" className="muted">
                        {item.quote}
                      </blockquote>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="muted text-xs">{t('needsReview', { model: reply.model })}</p>
        </div>
      )}
    </div>
  );
}
