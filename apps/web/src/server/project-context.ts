import { SanadError } from '@bahith/db';
import { z } from 'zod';

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
