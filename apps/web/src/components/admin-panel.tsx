'use client';

import type { PlatformStats } from '@bahith/db';
import { useTranslations } from 'next-intl';
import type { SubmitEvent } from 'react';
import { useState } from 'react';

interface PlanView {
  code: string;
  name: string;
  limits: Record<string, number>;
}

const COUNTS = [
  'users',
  'verifiedUsers',
  'workspaces',
  'projects',
  'sources',
  'chunks',
  'embeddedChunks',
  'documents',
  'aiRequestsThisMonth',
] as const;

/** Aggregate platform numbers (bento grid) and per-plan monthly AI limits. */
export function AdminPanel({ stats, plans }: { stats: PlatformStats; plans: PlanView[] }) {
  const t = useTranslations('Admin');
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const save = async (event: SubmitEvent<HTMLFormElement>, code: string) => {
    event.preventDefault();
    const value = Number(new FormData(event.currentTarget).get('limit'));
    const response = await fetch(`/api/admin/plans/${code}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiRequestsPerMonth: value }),
    }).catch(() => null);
    setNotice(
      response?.ok === true
        ? { kind: 'success', text: t('saved') }
        : { kind: 'error', text: t('error') },
    );
  };

  return (
    <div className="space-y-6">
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label={t('title')}>
        {COUNTS.map((key, index) => (
          <li
            key={key}
            className={`surface space-y-1 p-5 ${index === 0 ? 'sm:col-span-2' : ''}`}
            data-testid={`stat-${key}`}
          >
            <p className="muted text-sm">{t(key)}</p>
            <p className="text-3xl font-bold tabular-nums">{stats[key]}</p>
          </li>
        ))}
        {(['files', 'agentRunsThisMonth'] as const).map((key) => (
          <li key={key} className="surface space-y-2 p-5 sm:col-span-2">
            <p className="muted text-sm">{t(key === 'files' ? 'files' : 'runs')}</p>
            <dl className="flex flex-wrap gap-x-6 gap-y-1">
              {Object.entries(stats[key]).map(([status, count]) => (
                <div key={status} className="flex gap-2">
                  <dt dir="ltr" className="muted">
                    {status}
                  </dt>
                  <dd className="font-semibold tabular-nums">{count}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <section className="surface space-y-4 p-5 sm:p-6" aria-labelledby="plans-title">
        <h2 className="section-title" id="plans-title">
          {t('plans')}
        </h2>
        <p className="muted text-sm">{t('plansHelp')}</p>
        {notice === null ? null : (
          <p
            className={notice.kind === 'error' ? 'error-text' : 'text-sm'}
            role={notice.kind === 'error' ? 'alert' : 'status'}
          >
            {notice.text}
          </p>
        )}
        <ul className="space-y-3">
          {plans.map((plan) => (
            <li key={plan.code}>
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(event) => void save(event, plan.code)}
              >
                <div className="space-y-1">
                  <label className="block text-sm font-medium" htmlFor={`limit-${plan.code}`}>
                    {t('limitFor', { plan: plan.name })}
                  </label>
                  <input
                    id={`limit-${plan.code}`}
                    name="limit"
                    type="number"
                    min={0}
                    max={1_000_000}
                    required
                    className="field w-40"
                    defaultValue={plan.limits.ai_requests_per_month ?? ''}
                    placeholder={t('notSet')}
                  />
                </div>
                <button className="btn" type="submit">
                  {t('save')}
                </button>
              </form>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
