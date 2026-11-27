import {
  getWorkspaceUsage,
  listDocuments,
  listHighlights,
  listNotifications,
  listProjectLibrary,
  listUserProjects,
} from '@bahith/db';
import type { NotificationEntry, WorkspaceUsage } from '@bahith/db';

import { buildOverview } from '@/lib/dashboard-overview';
import type { DashboardOverview, ProjectDetails } from '@/lib/dashboard-overview';

import { getDatabase } from './db';

export function getDashboardData(userId: string) {
  return listUserProjects(getDatabase(), userId);
}

/** Details (library, drafts, highlights) are read for the newest projects only. */
export const OVERVIEW_PROJECT_LIMIT = 12;

export interface DashboardExtras {
  overview: DashboardOverview;
  notifications: NotificationEntry[];
  usage: { workspaceId: string; value: WorkspaceUsage } | null;
}

/**
 * Everything the research dashboard shows beyond the project list. Each read goes through
 * the same RLS-protected service the project page uses, as the signed-in user; a project
 * whose details cannot be read is counted as such, never filled in.
 */
export async function getDashboardExtras(
  userId: string,
  data: Awaited<ReturnType<typeof getDashboardData>>,
): Promise<DashboardExtras> {
  const database = getDatabase();
  const newest = [...data.projects]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, OVERVIEW_PROJECT_LIMIT);
  const details = new Map<string, ProjectDetails>();
  let failed = 0;
  await Promise.all(
    newest.map(async (project) => {
      const context = { userId, workspaceId: project.workspaceId, projectId: project.id };
      try {
        const [library, documents, highlights] = await Promise.all([
          listProjectLibrary(database, context),
          listDocuments(database, context),
          listHighlights(database, context),
        ]);
        details.set(project.id, { library, documents, highlights });
      } catch {
        failed += 1;
      }
    }),
  );
  const personal =
    data.workspaces.find((workspace) => workspace.role === 'owner') ?? data.workspaces[0];
  const [notifications, usage] = await Promise.all([
    listNotifications(database, { userId }, { limit: 4 })
      .then((result) => result.notifications)
      .catch(() => []),
    personal === undefined
      ? Promise.resolve(null)
      : getWorkspaceUsage(database, { userId, workspaceId: personal.id })
          .then((value) => ({ workspaceId: personal.id, value }))
          .catch(() => null),
  ]);
  return {
    overview: buildOverview(newest, details, {
      now: new Date(),
      total: data.projects.length,
      failed,
    }),
    notifications,
    usage,
  };
}
