import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database, Tx } from '../client';
import { memberships, projects } from '../schema/index';

import { SanadError } from './errors';

export const sanadContextSchema = z.object({
  userId: z.uuid(),
  workspaceId: z.uuid(),
  projectId: z.uuid(),
});

/** userId must come from a trusted authenticated server, never from an HTTP body. */
export type SanadProjectContext = z.infer<typeof sanadContextSchema>;

/**
 * Authorizes membership and project access inside the same transaction as the work.
 * Shared row locks prevent membership revocation or project deletion mid-operation.
 * withWorkspace itself only binds RLS context; it does not authorize the caller.
 */
export async function withSanadProject<T>(
  database: Database,
  context: SanadProjectContext,
  write: boolean,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const parsed = sanadContextSchema.safeParse(context);
  if (!parsed.success) {
    throw new SanadError('SANAD_INVALID_INPUT', 'Expected a user, workspace, and project UUID.');
  }
  const { userId, workspaceId, projectId } = parsed.data;
  return database.withWorkspace(
    workspaceId,
    async (tx) => {
      const [member] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
        .for('share');
      if (member === undefined || (write && member.role !== 'owner' && member.role !== 'editor')) {
        throw new SanadError(
          'SANAD_FORBIDDEN',
          'The acting user is not permitted to perform this operation.',
        );
      }
      const [project] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))
        .for('share');
      if (project === undefined) {
        throw new SanadError(
          'SANAD_PROJECT_NOT_FOUND',
          'The project is unavailable in this workspace.',
        );
      }
      return fn(tx);
    },
    { userId },
  );
}
