import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Database } from '../../src/client';
import { createDatabase } from '../../src/client';
import { createProject, listUserProjects } from '../../src/projects';
import * as schema from '../../src/schema/index';

describe('authenticated project services', () => {
  let app: Database;
  let auth: Database;
  let a: { id: string };
  let b: { id: string };
  let workspaceId: string;
  beforeAll(async () => {
    app = createDatabase({ connectionString: inject('appUrl') });
    auth = createDatabase({ connectionString: inject('authUrl') });
    const [first] = await auth.db
      .insert(schema.users)
      .values({
        name: 'Project owner fixture',
        email: `projects-a-${crypto.randomUUID()}@example.test`,
      })
      .returning({ id: schema.users.id });
    const [second] = await auth.db
      .insert(schema.users)
      .values({
        name: 'Project outsider fixture',
        email: `projects-b-${crypto.randomUUID()}@example.test`,
      })
      .returning({ id: schema.users.id });
    if (!first || !second) throw new Error('Identity fixture missing');
    a = first;
    b = second;
    const [workspace] = (await listUserProjects(app, a.id)).workspaces;
    if (!workspace) throw new Error('Workspace fixture missing');
    workspaceId = workspace.id;
  });
  afterAll(async () => {
    await app.close();
    await auth.close();
  });
  it('starts with the actual personal workspace and an empty project list', async () => {
    const result = await listUserProjects(app, a.id);
    expect(result.workspaces).toEqual([
      { id: workspaceId, name: 'Project owner fixture', role: 'owner' },
    ]);
    expect(result.projects).toEqual([]);
  });
  it('persists a project and lists it only for workspace members', async () => {
    const created = await createProject(app, a.id, {
      workspaceId,
      title: 'منهج الدراسة',
      researchQuestion: 'سؤال اختبار برمجي',
      language: 'ar',
    });
    expect(created.createdBy).toBe(a.id);
    expect((await listUserProjects(app, a.id)).projects.map((row) => row.id)).toEqual([created.id]);
    expect((await listUserProjects(app, b.id)).projects).toEqual([]);
    await expect(
      createProject(app, b.id, { workspaceId, title: 'intruder' }),
    ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
  });
  it('permits viewer reads while denying writes', async () => {
    await app.withWorkspace(workspaceId, (tx) =>
      tx.insert(schema.memberships).values({ workspaceId, userId: b.id, role: 'viewer' }),
    );
    expect((await listUserProjects(app, b.id)).projects).toHaveLength(1);
    await expect(
      createProject(app, b.id, { workspaceId, title: 'viewer write' }),
    ).rejects.toMatchObject({ code: 'SANAD_FORBIDDEN' });
    await app.withWorkspace(workspaceId, (tx) =>
      tx.delete(schema.memberships).where(eq(schema.memberships.userId, b.id)),
    );
  });
  it('rejects identity injection and unbounded fields before writing', async () => {
    await expect(
      createProject(app, a.id, { workspaceId, title: 'valid', createdBy: b.id }),
    ).rejects.toMatchObject({ code: 'SANAD_INVALID_INPUT' });
    await expect(
      createProject(app, a.id, { workspaceId, title: 'x'.repeat(201) }),
    ).rejects.toMatchObject({ code: 'SANAD_INVALID_INPUT' });
  });
});
