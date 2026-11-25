import { and, eq, sql } from 'drizzle-orm';
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

export type MembershipRole = (typeof memberships.$inferSelect)['role'];

/**
 * What the caller is about to do. `read`: any member. `write` (changing research content):
 * owners and editors. `review` (commenting on and suggesting changes to a draft): owners,
 * editors and supervisors; a supervisor reviews but never writes content directly.
 */
export type SanadAccess = 'read' | 'review' | 'write';

const ALLOWED_ROLES: Record<SanadAccess, readonly MembershipRole[]> = {
  read: ['owner', 'editor', 'viewer', 'supervisor'],
  review: ['owner', 'editor', 'supervisor'],
  write: ['owner', 'editor'],
};

/** Whether a role may change research content (save drafts, accept suggestions, ...). */
export const canWriteContent = (role: MembershipRole): boolean =>
  ALLOWED_ROLES.write.includes(role);

/** Whether a role may comment on and suggest changes to a draft. */
export const canReview = (role: MembershipRole): boolean => ALLOWED_ROLES.review.includes(role);

/**
 * Authorizes membership and project access inside the same transaction as the work.
 * Shared row locks prevent membership revocation or project deletion mid-operation.
 * withWorkspace itself only binds RLS context; it does not authorize the caller.
 * `write` is the access level (`true` = 'write', `false` = 'read'); `fn` gets the role.
 */
export async function withSanadProject<T>(
  database: Database,
  context: SanadProjectContext,
  write: boolean | SanadAccess,
  fn: (tx: Tx, role: MembershipRole) => Promise<T>,
): Promise<T> {
  const access: SanadAccess = write === true ? 'write' : write === false ? 'read' : write;
  const parsed = sanadContextSchema.safeParse(context);
  if (!parsed.success) {
    throw new SanadError('SANAD_INVALID_INPUT', 'Expected a user, workspace, and project UUID.');
  }
  const { userId, workspaceId, projectId } = parsed.data;
  return database.withWorkspace(
    workspaceId,
    async (tx) => {
      // Named prepared statements: these checks run on every request, and planning them
      // cost about twice their execution under load. Postgres keeps the plan per connection.
      const [member] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.workspaceId, sql.placeholder('workspaceId')),
            eq(memberships.userId, sql.placeholder('userId')),
          ),
        )
        .for('share')
        .prepare('sanad_member_role')
        .execute({ workspaceId, userId });
      if (member === undefined || !ALLOWED_ROLES[access].includes(member.role)) {
        throw new SanadError(
          'SANAD_FORBIDDEN',
          'The acting user is not permitted to perform this operation.',
        );
      }
      const [project] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, sql.placeholder('workspaceId')),
            eq(projects.id, sql.placeholder('projectId')),
          ),
        )
        .for('share')
        .prepare('sanad_project_exists')
        .execute({ workspaceId, projectId });
      if (project === undefined) {
        throw new SanadError(
          'SANAD_PROJECT_NOT_FOUND',
          'The project is unavailable in this workspace.',
        );
      }
      return fn(tx, member.role);
    },
    { userId },
  );
}
