/**
 * The research dashboard's figures, computed only from the user's real records (projects,
 * their library, drafts and highlights, and notifications). Nothing here is estimated:
 * a stage counts as done only when the data shows it, and a stage the platform does not
 * track yet (the final review) is reported as such, not as progress.
 */

export interface ProjectRecord {
  id: string;
  workspaceId: string;
  title: string;
  researchQuestion: string | null;
  createdAt: string;
}

export interface ProjectDetails {
  library: {
    sourceId: string;
    title: string;
    year: number | null;
    verificationStatus: string;
    fullTextStatus: string;
    addedAt: string;
    files: { status: string }[];
  }[];
  documents: { id: string; updatedAt: string }[];
  highlights: { createdAt: string }[];
}

/** The tracked stages, in order. "review" is shown but not tracked by the platform yet. */
export const WORKFLOW_STEPS = ['question', 'sources', 'analysed', 'drafted'] as const;
export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export interface ProjectProgress {
  projectId: string;
  workspaceId: string;
  title: string;
  steps: Record<WorkflowStep, boolean>;
  /** Share of the tracked stages that are done (0–100). */
  percent: number;
  /** Most recent change seen in the project's data. */
  lastActivity: string;
}

export interface DashboardOverview {
  stats: { projects: number; sources: number; notes: number; drafts: number };
  /** Details are read for at most `limit` projects (newest first). */
  coverage: { counted: number; total: number; failed: number };
  progress: ProjectProgress[];
  recentSources: {
    sourceId: string;
    projectId: string;
    workspaceId: string;
    title: string;
    year: number | null;
    verified: boolean;
  }[];
  activity: { date: string; count: number }[];
  activityTotal: number;
  /** Events in the last 15 days compared with the 15 before, in percent (null: no base). */
  activityChange: number | null;
}

export function projectProgress(project: ProjectRecord, details: ProjectDetails): ProjectProgress {
  const steps: Record<WorkflowStep, boolean> = {
    question: (project.researchQuestion ?? '').trim() !== '',
    sources: details.library.length > 0,
    analysed: details.library.some((entry) => entry.files.some((file) => file.status === 'ready')),
    drafted: details.documents.length > 0,
  };
  const done = WORKFLOW_STEPS.filter((step) => steps[step]).length;
  const times = [
    project.createdAt,
    ...details.library.map((entry) => entry.addedAt),
    ...details.documents.map((document) => document.updatedAt),
    ...details.highlights.map((highlight) => highlight.createdAt),
  ];
  return {
    projectId: project.id,
    workspaceId: project.workspaceId,
    title: project.title,
    steps,
    percent: Math.round((done / WORKFLOW_STEPS.length) * 100),
    lastActivity: times.reduce(
      (latest, time) => (time > latest ? time : latest),
      project.createdAt,
    ),
  };
}

const DAY = 24 * 60 * 60 * 1000;
const dayKey = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Events per UTC day over the last `days` days (oldest first), today included. */
export function activitySeries(
  timestamps: readonly string[],
  now: Date,
  days = 30,
): { date: string; count: number }[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const counts = new Map<string, number>();
  for (let i = days - 1; i >= 0; i -= 1) counts.set(dayKey(today - i * DAY), 0);
  for (const timestamp of timestamps) {
    const key = dayKey(Date.parse(timestamp));
    const current = counts.get(key);
    if (current !== undefined) counts.set(key, current + 1);
  }
  return [...counts].map(([date, count]) => ({ date, count }));
}

export function activityChange(series: readonly { count: number }[]): number | null {
  const half = Math.floor(series.length / 2);
  const before = series.slice(0, half).reduce((sum, day) => sum + day.count, 0);
  const after = series.slice(half).reduce((sum, day) => sum + day.count, 0);
  if (before === 0) return null;
  return Math.round(((after - before) / before) * 100);
}

export function buildOverview(
  projects: readonly ProjectRecord[],
  details: ReadonlyMap<string, ProjectDetails>,
  options: { now: Date; total: number; failed: number },
): DashboardOverview {
  const progress: ProjectProgress[] = [];
  const timestamps: string[] = [];
  const recent: (DashboardOverview['recentSources'][number] & { addedAt: string })[] = [];
  let sources = 0;
  let notes = 0;
  let drafts = 0;
  for (const project of projects) {
    timestamps.push(project.createdAt);
    const detail = details.get(project.id);
    if (detail === undefined) continue;
    progress.push(projectProgress(project, detail));
    sources += detail.library.length;
    notes += detail.highlights.length;
    drafts += detail.documents.length;
    timestamps.push(
      ...detail.library.map((entry) => entry.addedAt),
      ...detail.documents.map((document) => document.updatedAt),
      ...detail.highlights.map((highlight) => highlight.createdAt),
    );
    for (const entry of detail.library) {
      recent.push({
        sourceId: entry.sourceId,
        projectId: project.id,
        workspaceId: project.workspaceId,
        title: entry.title,
        year: entry.year,
        verified: entry.verificationStatus === 'verified',
        addedAt: entry.addedAt,
      });
    }
  }
  progress.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  recent.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  const activity = activitySeries(timestamps, options.now);
  return {
    stats: { projects: options.total, sources, notes, drafts },
    coverage: { counted: details.size, total: options.total, failed: options.failed },
    progress,
    recentSources: recent.slice(0, 8).map(({ addedAt: _addedAt, ...rest }) => rest),
    activity,
    activityTotal: activity.reduce((sum, day) => sum + day.count, 0),
    activityChange: activityChange(activity),
  };
}
