import { SanadError, withSanadProject } from '@bahith/db';
import { z } from 'zod';

import { getDatabase } from './db';
import { getRequestSession } from './session';

export interface ProjectRequestContext {
  userId: string;
  workspaceId: string;
  projectId: string;
  userName: string;
}

/**
 * Authenticated user + project identifiers for project-scoped API routes. The user id
 * comes from the server session only; membership is checked by every service call.
 */
export async function projectContext(
  request: Request,
  params: Promise<{ projectId: string }>,
): Promise<ProjectRequestContext | null> {
  const session = await getRequestSession(request);
  if (session === null) return null;
  const projectId = z.uuid().safeParse((await params).projectId);
  const workspaceId = z.uuid().safeParse(new URL(request.url).searchParams.get('workspaceId'));
  if (!projectId.success || !workspaceId.success) throw new SanadError('SANAD_INVALID_INPUT');
  return {
    userId: session.user.id,
    userName: session.user.name,
    workspaceId: workspaceId.data,
    projectId: projectId.data,
  };
}

export const unauthenticated = () => Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 });

/**
 * Checks membership (and the owner/editor role when `write`) before a route does any
 * work of its own — an external registry lookup, parsing an upload — so outsiders are
 * refused up front, not only when the service finally writes.
 */
export async function requireProjectAccess(
  context: ProjectRequestContext,
  write: boolean,
): Promise<void> {
  await withSanadProject(getDatabase(), context, write, () => Promise.resolve());
}
