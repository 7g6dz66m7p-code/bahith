'use client';

import { useTranslations } from 'next-intl';
import type { SubmitEvent } from 'react';
import { useState } from 'react';

import type { AssistantReply } from '@/server/assistant';

const ERROR_KEYS = {
  AI_CONSENT_REQUIRED: 'errorConsent',
  AI_NOT_CONFIGURED: 'errorNotConfigured',
  AI_PROVIDER_KEY_MISSING: 'errorKeyMissing',
  AI_PROVIDER_UNSUPPORTED: 'errorNotConfigured',
  AI_QUOTA_NOT_CONFIGURED: 'errorQuotaNotConfigured',
  AI_QUOTA_EXCEEDED: 'errorQuotaExceeded',
  AI_TIMEOUT: 'errorTimeout',
  AI_PROVIDER_ERROR: 'errorProvider',
  AI_OUTPUT_INVALID: 'errorProvider',
} as const;

function errorKey(code: unknown): (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS] | 'errorGeneric' {
  return typeof code === 'string' && code in ERROR_KEYS
    ? ERROR_KEYS[code as keyof typeof ERROR_KEYS]
    : 'errorGeneric';
}

const SUPPORT_CLASS = {
  supported: 'support-supported',
  inference: 'support-inference',
  unsupported: 'support-unsupported',
} as const;

/**
 * Evidence-grounded Q&A for one project. Nothing is sent to a provider before an
 * owner/editor consents; every sentence shows its verified passages and stored pages.
 */
export function AssistantPanel({
  projectId,
  workspaceId,
  canWrite,
  language,
  initialConsent,
  model,
}: {
  projectId: string;
  workspaceId: string;
  canWrite: boolean;
  language: 'ar' | 'en';
  initialConsent: boolean;
  model: string | null;
}) {
  const t = useTranslations('Assistant');
  const [consent, setConsent] = useState(initialConsent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<AssistantReply | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const query = `workspaceId=${workspaceId}`;
  const base = `/api/projects/${projectId}`;
  const modelLabel = model ?? t('modelNotConfigured');

  const changeConsent = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${base}/ai-consent?${query}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (response.ok) setConsent(enabled);
      else setError(t('errorGeneric'));
    } catch {
      setError(t('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const ask = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = new FormData(event.currentTarget).get('question');
    if (typeof question !== 'string' || question.trim() === '') return;
    setBusy(true);
    setError(null);
    setReply(null);
    try {
      const response = await fetch(`${base}/assistant?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, conversationId, language }),
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<AssistantReply> & {
        code?: string;
      };
      if (!response.ok) {
        setError(t(errorKey(payload.code)));
        return;
      }
      const answer = payload as AssistantReply;
      setReply(answer);
      setConversationId(answer.conversationId);
    } catch {
      setError(t('errorGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const dropped =
    reply === null ? 0 : reply.diagnostics.unknownPassages + reply.diagnostics.unverifiedQuotes;

  return (
    <section className="surface space-y-5 p-5 sm:p-6" aria-labelledby="assistant-title">
      <div className="space-y-1">
        <h2 className="section-title" id="assistant-title">
          {t('title')}
        </h2>
        <p className="muted text-sm leading-relaxed">{t('description')}</p>
      </div>

      {consent ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="muted" data-testid="consent-state">
            {t('consentGiven', { model: modelLabel })}
          </p>
          {canWrite ? (
            <button
              className="btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => void changeConsent(false)}
            >
              {t('withdrawConsent')}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3 rounded-xl border border-border p-4">
          <h3 className="font-semibold">{t('consentTitle')}</h3>
          <p className="text-sm leading-relaxed">{t('consentBody', { model: modelLabel })}</p>
          {canWrite ? (
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => void changeConsent(true)}
            >
              {t('grantConsent')}
            </button>
          ) : (
            <p className="muted text-sm">{t('consentReadOnly')}</p>
          )}
        </div>
      )}

      {consent && canWrite ? (
        <form className="space-y-3" onSubmit={(event) => void ask(event)}>
          <label className="block text-sm font-medium" htmlFor="assistant-question">
            {t('questionLabel')}
          </label>
          <textarea
            id="assistant-question"
            name="question"
            className="field min-h-24 w-full"
            dir="auto"
            maxLength={2000}
            required
            placeholder={t('questionPlaceholder')}
          />
          <button className="btn" type="submit" disabled={busy}>
            {t(busy ? 'asking' : 'ask')}
          </button>
        </form>
      ) : null}

      {error === null ? null : (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {reply === null ? null : (
        <div className="space-y-4" aria-live="polite" data-testid="assistant-answer">
          {reply.status === 'abstained' ? (
            <p className="font-medium" role="status">
              {t(reply.reason === 'NO_EVIDENCE' ? 'noEvidence' : 'abstained')}
            </p>
          ) : (
            <ol className="space-y-4">
              {reply.sentences.map((sentence, index) => (
                <li key={index} className="space-y-2" data-support={sentence.support}>
                  <p dir="auto" className="leading-relaxed">
                    {sentence.text}{' '}
                    <span className={`support-badge ${SUPPORT_CLASS[sentence.support]}`}>
                      {t(sentence.support)}
                    </span>
                  </p>
                  {sentence.evidence.length === 0 ? null : (
                    <ul className="space-y-2 border-s-2 border-border ps-3 text-sm">
                      {sentence.evidence.map((item) => (
                        <li key={`${item.chunkId}-${item.quote}`} className="space-y-1">
                          <blockquote dir="auto" className="muted">
                            {item.quote}
                          </blockquote>
                          <p className="flex flex-wrap gap-x-3">
                            <span dir="auto" className="font-medium">
                              {item.sourceTitle}
                            </span>
                            <span data-testid="assistant-page">
                              {item.pageStart === null
                                ? t('abstractOnly')
                                : item.pageEnd !== null && item.pageEnd !== item.pageStart
                                  ? t('pageRange', { start: item.pageStart, end: item.pageEnd })
                                  : t('page', { page: item.pageStart })}
                            </span>
                            {item.fileId !== null && item.pageStart !== null ? (
                              <a
                                className="underline underline-offset-4"
                                href={`${base}/files/${item.fileId}?${query}#page=${String(item.pageStart)}`}
                                target="_blank"
                                rel="noopener"
                              >
                                {t('openAtPage')}
                              </a>
                            ) : null}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
          {dropped > 0 ? <p className="muted text-sm">{t('dropped', { count: dropped })}</p> : null}
          <p className="muted text-xs">{t('answeredBy', { model: reply.model })}</p>
        </div>
      )}
    </section>
  );
}
