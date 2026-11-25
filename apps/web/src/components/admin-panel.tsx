'use client';

import type { PlatformStats } from '@bahith/db';
import { useFormatter, useTranslations } from 'next-intl';
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
export interface ModelUsageView {
  label: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export function AdminPanel({
  stats,
  plans,
  usage,
}: {
  stats: PlatformStats;
  plans: PlanView[];
  usage: ModelUsageView[];
}) {
  const t = useTranslations('Admin');
  const format = useFormatter();
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
      <section className="surface space-y-4 p-5 sm:p-6" aria-labelledby="usage-title">
        <h2 className="section-title" id="usage-title">
          {t('usageTitle')}
        </h2>
        <p className="muted text-sm">{t('usageHelp')}</p>
        {usage.length === 0 ? (
          <p className="text-sm">{t('usageNone')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="ai-usage">
              <thead>
                <tr className="text-start">
                  <th className="pe-4 text-start">{t('usageModel')}</th>
                  <th className="pe-4 text-start">{t('usageRuns')}</th>
                  <th className="pe-4 text-start">{t('usageInput')}</th>
                  <th className="pe-4 text-start">{t('usageOutput')}</th>
                  <th className="text-start">{t('usageCost')}</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((row) => (
                  <tr key={row.label}>
                    <td dir="ltr" className="pe-4 text-start">
                      {row.label}
                    </td>
                    <td className="pe-4 tabular-nums">{format.number(row.runs)}</td>
                    <td className="pe-4 tabular-nums">{format.number(row.inputTokens)}</td>
                    <td className="pe-4 tabular-nums">{format.number(row.outputTokens)}</td>
                    <td className="tabular-nums">
                      {row.costUsd === null
                        ? t('usageCostUnknown')
                        : format.number(row.costUsd, {
                            style: 'currency',
                            currency: 'USD',
                            maximumFractionDigits: 4,
                          })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
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
                method="post"
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
