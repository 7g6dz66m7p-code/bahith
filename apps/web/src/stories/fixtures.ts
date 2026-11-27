/**
 * STORYBOOK FIXTURES ONLY — synthetic values to render the components in isolation.
 * They are never imported by application code; the product shows only real records.
 */
import type { DashboardOverview, ProjectProgress } from '@/lib/dashboard-overview';
import { activitySeries } from '@/lib/dashboard-overview';

const NOW = new Date('2026-11-26T12:00:00Z');

export const fixtureProgress: ProjectProgress[] = [
  {
    projectId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-0000000000aa',
    title: 'رسالة الماجستير (مثال توضيحي)',
    steps: { question: true, sources: true, analysed: true, drafted: false },
    percent: 75,
    lastActivity: '2026-11-26T09:14:00Z',
  },
  {
    projectId: '00000000-0000-4000-8000-000000000002',
    workspaceId: '00000000-0000-4000-8000-0000000000aa',
    title: 'بحث العقائد (مثال توضيحي)',
    steps: { question: true, sources: true, analysed: false, drafted: false },
    percent: 50,
    lastActivity: '2026-11-25T16:07:00Z',
  },
];

const events = [
  ...Array.from({ length: 18 }, (_, i) =>
    new Date(NOW.getTime() - i * 1.4 * 86_400_000).toISOString(),
  ),
  ...Array.from({ length: 9 }, (_, i) =>
    new Date(NOW.getTime() - i * 0.9 * 86_400_000).toISOString(),
  ),
];

export const fixtureOverview: DashboardOverview = {
  stats: { projects: 2, sources: 6, notes: 4, drafts: 1 },
  coverage: { counted: 2, total: 2, failed: 0 },
  progress: fixtureProgress,
  recentSources: [
    {
      sourceId: 's1',
      projectId: 'p1',
      workspaceId: 'w1',
      title: 'مصدر توضيحي في مناهج البحث',
      year: 2023,
      verified: true,
    },
    {
      sourceId: 's2',
      projectId: 'p1',
      workspaceId: 'w1',
      title: 'Illustrative source on blended learning',
      year: 2022,
      verified: false,
    },
    {
      sourceId: 's3',
      projectId: 'p1',
      workspaceId: 'w1',
      title: 'مصدر توضيحي ثالث',
      year: 2021,
      verified: true,
    },
  ],
  activity: activitySeries(events, NOW),
  activityTotal: events.length,
  activityChange: 42,
};

export const emptyOverview: DashboardOverview = {
  stats: { projects: 0, sources: 0, notes: 0, drafts: 0 },
  coverage: { counted: 0, total: 0, failed: 0 },
  progress: [],
  recentSources: [],
  activity: activitySeries([], NOW),
  activityTotal: 0,
  activityChange: null,
};

export const fixtureTarget = {
  workspaceId: '00000000-0000-4000-8000-0000000000aa',
  projectId: '00000000-0000-4000-8000-000000000001',
};
