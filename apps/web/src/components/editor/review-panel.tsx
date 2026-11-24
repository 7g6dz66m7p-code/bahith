'use client';

import type { ReviewComment } from '@bahith/db';
import { useTranslations } from 'next-intl';
import type { SubmitEvent } from 'react';
import { useState } from 'react';

/** The text currently selected in the editor, when it can be anchored. */
export interface ReviewSelection {
  from: number;
  to: number;
  quote: string;
}

export type ReviewNotice =
  | { kind: 'accepted'; version: number }
  | { kind: 'error'; code: 'stale' | 'invalidAnchor' | 'conflict' | 'failed' };

interface ReviewPanelProps {
  comments: ReviewComment[];
  /** null: nothing selected; 'invalid': a selection that cannot be anchored. */
  selection: ReviewSelection | 'invalid' | null;
  canReview: boolean;
  canDecide: boolean;
  busy: boolean;
  notice: ReviewNotice | null;
  onAdd: (
    selection: ReviewSelection,
    note:
      { kind: 'comment'; body: string } | { kind: 'suggestion'; replacement: string; body: string },
  ) => Promise<boolean>;
  onAction: (comment: ReviewComment, action: 'resolve' | 'accept' | 'reject') => void;
}

const ROLES = ['owner', 'editor', 'viewer', 'supervisor'] as const;

/** Comments and suggested changes beside the draft. All decisions are made on the server. */
export function ReviewPanel(props: ReviewPanelProps) {
  const t = useTranslations('Draft.review');
  const [mode, setMode] = useState<'none' | 'comment' | 'suggestion'>('none');
  // The selection is kept while the form has the focus (the editor loses it).
  const [target, setTarget] = useState<ReviewSelection | null>(null);
  const open = props.comments.filter((comment) => comment.status === 'open');
  const closed = props.comments.filter((comment) => comment.status !== 'open');
  const selection = typeof props.selection === 'object' ? props.selection : null;

  const start = (next: 'comment' | 'suggestion') => {
    if (selection === null) return;
    setTarget(selection);
    setMode(next);
  };

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (target === null || mode === 'none') return;
    const form = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === 'string' ? value : '';
    };
    const body = field('body').trim();
    const ok = await props.onAdd(
      target,
      mode === 'comment'
        ? { kind: 'comment', body }
        : { kind: 'suggestion', replacement: field('replacement'), body },
    );
    if (ok) {
      setMode('none');
      setTarget(null);
    }
  };

  const byline = (comment: ReviewComment) => {
    const role = ROLES.find((item) => item === comment.authorRole);
    return t('byline', {
      name: comment.authorName === '' ? t('unknownAuthor') : comment.authorName,
      role: role === undefined ? t('formerMember') : t(`role.${role}`),
    });
  };

  const note = (comment: ReviewComment) => (
    <li
      key={comment.id}
      className="space-y-2 rounded-xl border border-border p-3"
      data-testid="review-note"
      data-kind={comment.kind}
      data-status={comment.status}
    >
      <p className="muted flex flex-wrap gap-x-2 text-xs">
        <span className="font-semibold">{t(`kind.${comment.kind}`)}</span>
        <span dir="auto">{byline(comment)}</span>
        {comment.status === 'open' ? null : <span>{t(`status.${comment.status}`)}</span>}
      </p>
      <blockquote className="review-quote muted text-sm" dir="auto">
        {comment.anchor.quote}
      </blockquote>
      {comment.suggestion === null ? null : (
        <p className="text-sm">
          <span className="muted">{t('replaceWith')} </span>
          {comment.suggestion.replacement === '' ? (
            <span className="diff-removed">{t('deleteText')}</span>
          ) : (
            <ins className="diff-added" dir="auto">
              {comment.suggestion.replacement}
            </ins>
          )}
        </p>
      )}
      {comment.body === '' ? null : (
        <p className="text-sm leading-relaxed whitespace-pre-wrap" dir="auto">
          {comment.body}
        </p>
      )}
      {comment.status !== 'open' ? null : (
        <div className="flex flex-wrap gap-2">
          {comment.kind === 'comment' && props.canReview ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={props.busy}
              onClick={() => {
                props.onAction(comment, 'resolve');
              }}
            >
              {t('resolve')}
            </button>
          ) : null}
          {comment.kind === 'suggestion' && props.canDecide ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={props.busy}
                onClick={() => {
                  props.onAction(comment, 'accept');
                }}
              >
                {t('accept')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={props.busy}
                onClick={() => {
                  props.onAction(comment, 'reject');
                }}
              >
                {t('reject')}
              </button>
            </>
          ) : null}
        </div>
      )}
    </li>
  );

  return (
    <aside className="surface space-y-4 p-4" aria-labelledby="review-title">
      <h2 id="review-title" className="section-title">
        {t('title')}
      </h2>

      {props.canReview ? (
        <div className="space-y-2">
          <p className="muted text-sm">
            {props.selection === 'invalid' ? t('selectionInvalid') : t('hint')}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={selection === null || props.busy}
              onClick={() => {
                start('comment');
              }}
            >
              {t('comment')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={selection === null || props.busy}
              onClick={() => {
                start('suggestion');
              }}
            >
              {t('suggest')}
            </button>
          </div>
        </div>
      ) : null}

      {mode === 'none' || target === null ? null : (
        <form method="post" className="space-y-2" onSubmit={(event) => void submit(event)}>
          <p className="muted text-xs">{t('selected')}</p>
          <blockquote className="review-quote text-sm" dir="auto" data-testid="review-target">
            {target.quote}
          </blockquote>
          {mode === 'suggestion' ? (
            <>
              <label className="block text-sm" htmlFor="review-replacement">
                {t('replacementLabel')}
              </label>
              <input
                id="review-replacement"
                name="replacement"
                className="field w-full"
                dir="auto"
                maxLength={5000}
                defaultValue={target.quote}
              />
            </>
          ) : null}
          <label className="block text-sm" htmlFor="review-body">
            {mode === 'comment' ? t('commentLabel') : t('noteLabel')}
          </label>
          <textarea
            id="review-body"
            name="body"
            className="field w-full"
            dir="auto"
            rows={3}
            maxLength={5000}
            required={mode === 'comment'}
          />
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn" disabled={props.busy}>
              {mode === 'comment' ? t('addComment') : t('addSuggestion')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setMode('none');
                setTarget(null);
              }}
            >
              {t('cancel')}
            </button>
          </div>
        </form>
      )}

      {props.notice === null ? null : props.notice.kind === 'accepted' ? (
        <p className="success-text text-sm" role="status" data-testid="review-notice">
          {t('accepted', { version: props.notice.version })}
        </p>
      ) : (
        <p className="error-text text-sm" role="alert" data-testid="review-notice">
          {t(`error.${props.notice.code}`)}
        </p>
      )}

      <section className="space-y-2" aria-labelledby="review-open-title">
        <h3 id="review-open-title" className="text-sm font-semibold">
          {t('openTitle', { count: open.length })}
        </h3>
        {open.length === 0 ? (
          <p className="muted text-sm">{t('none')}</p>
        ) : (
          <ul className="space-y-2">{open.map(note)}</ul>
        )}
      </section>

      {closed.length === 0 ? null : (
        <details className="space-y-2">
          <summary className="cursor-pointer text-sm">
            {t('closedTitle', { count: closed.length })}
          </summary>
          <ul className="mt-2 space-y-2">{closed.map(note)}</ul>
        </details>
      )}
    </aside>
  );
}
