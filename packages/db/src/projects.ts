import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database, Tx } from './client';
import { memberships, projects, workspaces } from './schema/index';
import { SanadError } from './sanad/errors';

export const createProjectSchema = z.strictObject({
  workspaceId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  researchQuestion: z.string().trim().max(5000).default(''),
  language: z.enum(['ar', 'en']).default('ar'),
});

export async function withWorkspaceMember<T>(
  database: Database,
  userId: string,
  workspaceId: string,
  write: boolean,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!z.uuid().safeParse(userId).success || !z.uuid().safeParse(workspaceId).success) {
    throw new SanadError('SANAD_INVALID_INPUT');
  }
  return database.withWorkspace(
    workspaceId,
    async (tx) => {
      const [member] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)))
        .for('share');
      if (member === undefined || (write && member.role !== 'owner' && member.role !== 'editor')) {
        throw new SanadError('SANAD_FORBIDDEN');
      }
      return fn(tx);
    },
    { userId },
  );
}

export async function listUserProjects(database: Database, userId: string) {
  if (!z.uuid().safeParse(userId).success) throw new SanadError('SANAD_INVALID_INPUT');
  const spaces = await database.withUser(userId, (tx) =>
    tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        role: memberships.role,
      })
      .from(workspaces)
      .innerJoin(memberships, eq(memberships.workspaceId, workspaces.id))
      .where(eq(memberships.userId, userId))
      .orderBy(workspaces.createdAt),
  );
  const rows = await Promise.all(
    spaces.map((space) =>
      withWorkspaceMember(database, userId, space.id, false, (tx) =>
        tx
          .select({
            id: projects.id,
            workspaceId: projects.workspaceId,
            title: projects.title,
            researchQuestion: projects.researchQuestion,
            language: projects.language,
            createdAt: projects.createdAt,
          })
          .from(projects)
          .where(and(eq(projects.workspaceId, space.id), eq(projects.status, 'active')))
          .orderBy(desc(projects.createdAt)),
      ),
    ),
  );
  return {
    workspaces: spaces,
    projects: rows.flat().map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
  };
}

export async function createProject(database: Database, userId: string, input: unknown) {
  const parsed = createProjectSchema.safeParse(input);
  if (!parsed.success) throw new SanadError('SANAD_INVALID_INPUT');
  return withWorkspaceMember(database, userId, parsed.data.workspaceId, true, async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({ ...parsed.data, createdBy: userId })
      .returning();
    if (project === undefined) throw new SanadError('SANAD_INVALID_INPUT');
    return project;
  });
}
