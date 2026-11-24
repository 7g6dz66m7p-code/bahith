import {
  getProjectAiConsent,
  getProjectForUser,
  listDocuments,
  listProjectLibrary,
  listProjectSourceMetadata,
  SanadError,
} from '@bahith/db';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { locale as rootLocale } from 'next/root-params';
import { z } from 'zod';

import { ProjectWorkspace } from '@/components/project-workspace';
import { routing } from '@/i18n/routing';
import { configuredChatModel } from '@/server/assistant';
import { getDatabase } from '@/server/db';
import { getUnreadNotificationCount } from '@/server/notifications';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ workspaceId: z.uuid(), projectId: z.uuid() });

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const locale = await rootLocale();
  if (!hasLocale(routing.locales, locale)) notFound();
  const session = await requireSession(locale);
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { workspaceId, projectId } = parsed.data;
  const database = getDatabase();
  const data = await Promise.all([
    getProjectForUser(database, session.user.id, workspaceId, projectId),
    listProjectLibrary(database, { userId: session.user.id, workspaceId, projectId }),
    listDocuments(database, { userId: session.user.id, workspaceId, projectId }),
    listProjectSourceMetadata(database, { userId: session.user.id, workspaceId, projectId }),
    getProjectAiConsent(database, { userId: session.user.id, workspaceId, projectId }),
    getUnreadNotificationCount(session.user.id),
  ]).catch((error: unknown) => {
    // Not a member, or not this workspace's project: indistinguishable from "missing".
    if (error instanceof SanadError) return null;
    throw error;
  });
  if (data === null) notFound();
  const [project, library, drafts, references, consent, unread] = data;
  return (
    <ProjectWorkspace
      project={project}
      initialLibrary={library}
      drafts={drafts}
      references={references}
      assistant={{ consent: consent.enabled, model: configuredChatModel() }}
      unreadNotifications={unread}
    />
  );
}
