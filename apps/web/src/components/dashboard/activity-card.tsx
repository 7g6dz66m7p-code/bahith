'use client';

import { GlassCard, GlassSkeleton } from '@bahith/ui';
import { TrendingUp } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useLocale, useTranslations } from 'next-intl';

import type { DashboardOverview } from '@/lib/dashboard-overview';

// Recharts is only needed for this panel: load it after the page, keep first load light.
const ActivityChart = dynamic(() => import('./activity-chart'), {
  ssr: false,
  loading: () => <GlassSkeleton lines={4} />,
});

export function ActivityCard({ overview }: { overview: DashboardOverview }) {
  const t = useTranslations('Glass.chart');
  const locale = useLocale();
  const change = overview.activityChange;
  const percent = new Intl.NumberFormat(locale, { style: 'percent', signDisplay: 'exceptZero' });
  return (
    <GlassCard
      title={t('title')}
      headingId="chart-title"
      icon={<TrendingUp className="size-5" />}
      action={
        change === null ? null : <span className="lg-badge">{percent.format(change / 100)}</span>
      }
    >
      <p className="mb-2 text-sm font-semibold">{t('total', { count: overview.activityTotal })}</p>
      <ActivityChart data={overview.activity} locale={locale} />
      <p className="muted mt-2 text-xs">
        <span className="block">
          {change === null ? t('noBase') : t('change', { value: change })}
        </span>
        <span className="block">{t('basis')}</span>
      </p>
    </GlassCard>
  );
}
