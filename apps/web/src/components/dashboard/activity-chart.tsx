'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * The 30-day activity area chart (Recharts; loaded on demand). Decorative for assistive
 * tech: the same figures are given as text and as a table next to it.
 */
export default function ActivityChart({
  data,
  locale,
}: {
  data: { date: string; count: number }[];
  locale: string;
}) {
  const label = (date: string) =>
    new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
      new Date(`${date}T00:00:00Z`),
    );
  return (
    <div dir="ltr" className="h-44 w-full" aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        {/* Not focusable: the figures are given as text beside the chart. */}
        <AreaChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: -24 }}
          accessibilityLayer={false}
        >
          <defs>
            <linearGradient id="activity-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--lg-neon)" stopOpacity={0.55} />
              <stop offset="1" stopColor="var(--lg-neon)" stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--lg-track)" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={label}
            tick={{ fill: 'var(--muted)', fontSize: 11 }}
            interval={6}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: 'var(--muted)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            labelFormatter={(value) => (typeof value === 'string' ? label(value) : '')}
            contentStyle={{
              background: 'var(--lg-surface-solid)',
              border: '1px solid var(--lg-edge)',
              borderRadius: 12,
              color: 'var(--foreground)',
            }}
          />
          <Area
            type="monotone"
            dataKey="count"
            stroke="var(--lg-ink)"
            strokeWidth={2.5}
            fill="url(#activity-fill)"
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
