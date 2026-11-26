import { describe, expect, it } from 'vitest';

import {
  activityChange,
  activitySeries,
  buildOverview,
  projectProgress,
} from '../../src/lib/dashboard-overview';
import type { ProjectDetails, ProjectRecord } from '../../src/lib/dashboard-overview';

const project = (id: string, question: string | null, createdAt: string): ProjectRecord => ({
  id,
  workspaceId: 'w1',
  title: `Project ${id}`,
  researchQuestion: question,
  createdAt,
});
const empty: ProjectDetails = { library: [], documents: [], highlights: [] };
const source = (addedAt: string, status: string, verified = false) => ({
  sourceId: `s-${addedAt}`,
  title: `Source ${addedAt}`,
  year: 2024,
  verificationStatus: verified ? 'verified' : 'unverified',
  fullTextStatus: 'full_text',
  addedAt,
  files: [{ status }],
});

describe('projectProgress', () => {
  it('counts only stages the data shows', () => {
    expect(projectProgress(project('a', null, '2026-11-01T00:00:00Z'), empty)).toMatchObject({
      percent: 0,
      steps: { question: false, sources: false, analysed: false, drafted: false },
    });
    const half = projectProgress(project('b', '  why?  ', '2026-11-01T00:00:00Z'), {
      ...empty,
      library: [source('2026-11-02T00:00:00Z', 'processing')],
    });
    expect(half.steps).toEqual({ question: true, sources: true, analysed: false, drafted: false });
    expect(half.percent).toBe(50);
    expect(half.lastActivity).toBe('2026-11-02T00:00:00Z');
  });

  it('a blank question is not a question, and a ready file means analysed', () => {
    const progress = projectProgress(project('c', '   ', '2026-11-01T00:00:00Z'), {
      library: [source('2026-11-03T00:00:00Z', 'ready')],
      documents: [{ id: 'd', updatedAt: '2026-11-05T00:00:00Z' }],
      highlights: [],
    });
    expect(progress.steps).toEqual({
      question: false,
      sources: true,
      analysed: true,
      drafted: true,
    });
    expect(progress.percent).toBe(75);
    expect(progress.lastActivity).toBe('2026-11-05T00:00:00Z');
  });
});

describe('activity', () => {
  it('buckets events per UTC day over 30 days and ignores older ones', () => {
    const series = activitySeries(
      [
        '2026-11-26T08:00:00Z',
        '2026-11-26T23:59:00Z',
        '2026-10-28T00:00:00Z',
        '2026-10-01T00:00:00Z',
      ],
      new Date('2026-11-26T12:00:00Z'),
    );
    expect(series).toHaveLength(30);
    expect(series[0]).toEqual({ date: '2026-10-28', count: 1 });
    expect(series[29]).toEqual({ date: '2026-11-26', count: 2 });
    expect(series.reduce((sum, day) => sum + day.count, 0)).toBe(3);
  });

  it('change has no base when the first half is empty', () => {
    expect(activityChange([{ count: 0 }, { count: 3 }])).toBeNull();
    expect(activityChange([{ count: 2 }, { count: 3 }])).toBe(50);
    expect(activityChange([{ count: 4 }, { count: 1 }])).toBe(-75);
  });
});

describe('buildOverview', () => {
  it('sums real records and reports what was not read', () => {
    const projects = [
      project('a', 'q', '2026-11-20T00:00:00Z'),
      project('b', null, '2026-11-21T00:00:00Z'),
      project('c', null, '2026-11-22T00:00:00Z'),
    ];
    const details = new Map<string, ProjectDetails>([
      [
        'a',
        {
          library: [
            source('2026-11-23T00:00:00Z', 'ready', true),
            source('2026-11-24T00:00:00Z', 'ready'),
          ],
          documents: [{ id: 'd1', updatedAt: '2026-11-25T00:00:00Z' }],
          highlights: [{ createdAt: '2026-11-25T01:00:00Z' }],
        },
      ],
      ['b', empty],
    ]);
    const overview = buildOverview(projects, details, {
      now: new Date('2026-11-26T00:00:00Z'),
      total: 5,
      failed: 1,
    });
    expect(overview.stats).toEqual({ projects: 5, sources: 2, notes: 1, drafts: 1 });
    expect(overview.coverage).toEqual({ counted: 2, total: 5, failed: 1 });
    expect(overview.progress.map((p) => p.projectId)).toEqual(['a', 'b']);
    expect(overview.recentSources.map((s) => s.verified)).toEqual([false, true]);
    // 3 projects + 2 sources + 1 draft + 1 note
    expect(overview.activityTotal).toBe(7);
  });
});
