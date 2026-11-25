import { getDocument, getProjectForUser, listComments, SanadError } from '@bahith/db';
import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { locale as rootLocale } from 'next/root-params';
import { z } from 'zod';

import { DraftEditor } from '@/components/editor/draft-editor';
import { routing } from '@/i18n/routing';
import { getDatabase } from '@/server/db';
import { requireSession } from '@/server/session';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  documentId: z.uuid(),
});

export default async function DraftPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string; documentId: string }>;
}) {
  const locale = await rootLocale();
  if (!hasLocale(routing.locales, locale)) notFound();
  const session = await requireSession(locale);
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { workspaceId, projectId, documentId } = parsed.data;
  const database = getDatabase();
  const context = { userId: session.user.id, workspaceId, projectId };
  const data = await Promise.all([
    getProjectForUser(database, session.user.id, workspaceId, projectId),
    getDocument(database, context, documentId),
    listComments(database, context, documentId),
  ]).catch((error: unknown) => {
    if (error instanceof SanadError) return null;
    throw error;
  });
  if (data === null) notFound();
  const [project, draft, comments] = data;
  return (
    <DraftEditor
      workspaceId={workspaceId}
      projectId={projectId}
      documentId={documentId}
      title={draft.title}
      initialVersion={draft.version}
      initialContent={draft.content}
      canWrite={project.canWrite}
      role={project.role}
      initialComments={comments}
    />
  );
}
