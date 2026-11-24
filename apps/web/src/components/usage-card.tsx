'use client';

import type { WorkspaceUsage } from '@bahith/db';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

/** The workspace's plan and AI usage this month; upgrading is honest about payments being off. */
export function UsageCard({
  workspaceId,
  usage,
  isOwner,
}: {
  workspaceId: string;
  usage: WorkspaceUsage;
  isOwner: boolean;
}) {
  const t = useTranslations('Usage');
  const [message, setMessage] = useState<string | null>(null);
  const upgrade = async () => {
    const response = await fetch(`/api/workspaces/${workspaceId}/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planCode: 'pro' }),
    }).catch(() => null);
    const payload = (await response?.json().catch(() => ({}))) as { url?: string } | undefined;
    if (response?.ok === true && typeof payload?.url === 'string')
      window.location.assign(payload.url);
    else setMessage(t('paymentsDisabled'));
  };
  return (
    <section
      className="surface space-y-3 p-5 sm:p-6"
      aria-labelledby="usage-title"
      data-testid="usage"
    >
      <h2 className="section-title" id="usage-title">
        {t('title')}
      </h2>
      <p>{t('plan', { plan: usage.plan?.name ?? '—' })}</p>
      <p>
        {usage.aiRequests.limit === null
          ? t('unlimited')
          : t('used', { used: usage.aiRequests.used, limit: usage.aiRequests.limit })}
      </p>
      {isOwner ? (
        <button className="btn-secondary" type="button" onClick={() => void upgrade()}>
          {t('upgrade')}
        </button>
      ) : null}
      {message === null ? null : (
        <p className="muted text-sm" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
