import { getTableConfig } from 'drizzle-orm/pg-core';

import type { Database } from '../../src/client';
import * as schema from '../../src/schema/index';
import { allTables } from '../tables';

/** Names of every table that carries a `workspace_id` column (the tenant tables). */
export const tenantTableNames: string[] = allTables
  .map((table) => getTableConfig(table))
  .filter((config) => config.columns.some((column) => column.name === 'workspace_id'))
  .map((config) => config.name)
  .sort();

export interface WorkspaceFixture {
  userId: string;
  workspaceId: string;
  projectId: string;
  sourceId: string;
  fileId: string;
  chunkId: string;
  documentId: string;
  claimId: string;
}

function only<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined || rows.length !== 1) {
    throw new Error(`expected exactly one row, got ${rows.length}`);
  }
  return row;
}

export function embeddingOf(seed: number): number[] {
  return Array.from({ length: schema.EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(seed * (i + 1)));
}

/**
 * Creates a user with a personal workspace and at least one row in EVERY tenant table.
 * Everything is written through the application role and `withWorkspace`, so the fixture
 * itself proves that legitimate writes pass the RLS WITH CHECK policies.
 */
export async function seedWorkspace(
  database: Database,
  label: string,
  planId: string,
): Promise<WorkspaceFixture> {
  const user = only(
    await database.db
      .insert(schema.users)
      .values({ email: `${label}-${crypto.randomUUID()}@example.test`, name: `User ${label}` })
      .returning({ id: schema.users.id }),
  );
  const workspaceId = crypto.randomUUID();

  return database.withWorkspace(
    workspaceId,
    async (tx) => {
      await tx.insert(schema.workspaces).values({
        id: workspaceId,
        name: `Workspace ${label}`,
        createdBy: user.id,
      });
      await tx.insert(schema.memberships).values({ workspaceId, userId: user.id, role: 'owner' });

      const project = only(
        await tx
          .insert(schema.projects)
          .values({
            workspaceId,
            title: `مشروع ${label}`,
            researchQuestion: `سؤال بحثي ${label}`,
            createdBy: user.id,
          })
          .returning({ id: schema.projects.id }),
      );
      await tx.insert(schema.researchPlans).values({
        workspaceId,
        projectId: project.id,
        version: 1,
        content: { outline: [`plan ${label}`] },
      });

      const source = only(
        await tx
          .insert(schema.sources)
          .values({
            workspaceId,
            origin: 'upload',
            type: 'article-journal',
            title: `مصدر ${label}`,
            doi: `10.1234/${label.toLowerCase()}`,
            fullTextStatus: 'full_text',
          })
          .returning({ id: schema.sources.id }),
      );
      await tx
        .insert(schema.projectSources)
        .values({ workspaceId, projectId: project.id, sourceId: source.id });

      const file = only(
        await tx
          .insert(schema.files)
          .values({
            workspaceId,
            sourceId: source.id,
            storageKey: `${workspaceId}/${crypto.randomUUID()}.pdf`,
            originalName: `${label}.pdf`,
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            status: 'ready',
          })
          .returning({ id: schema.files.id }),
      );
      const chunk = only(
        await tx
          .insert(schema.chunks)
          .values({
            workspaceId,
            sourceId: source.id,
            fileId: file.id,
            chunkIndex: 0,
            pageStart: 3,
            pageEnd: 4,
            content: `الْإِحْصَاءُ الوصفي في دراسة ${label}`,
            embedding: embeddingOf(label.charCodeAt(0)),
            embeddingModel: 'test-embedding',
          })
          .returning({ id: schema.chunks.id }),
      );

      const run = only(
        await tx
          .insert(schema.agentRuns)
          .values({
            workspaceId,
            projectId: project.id,
            userId: user.id,
            agent: 'research-assistant',
            promptVersion: 'v0',
            provider: 'test',
            model: 'test-model',
          })
          .returning({ id: schema.agentRuns.id }),
      );
      const conversation = only(
        await tx
          .insert(schema.conversations)
          .values({ workspaceId, projectId: project.id, createdBy: user.id })
          .returning({ id: schema.conversations.id }),
      );
      const message = only(
        await tx
          .insert(schema.messages)
          .values({
            workspaceId,
            conversationId: conversation.id,
            role: 'assistant',
            content: { sentences: [] },
            agentRunId: run.id,
          })
          .returning({ id: schema.messages.id }),
      );
      const claim = only(
        await tx
          .insert(schema.claims)
          .values({
            workspaceId,
            projectId: project.id,
            messageId: message.id,
            text: `ادعاء ${label}`,
            supportStatus: 'supported',
          })
          .returning({ id: schema.claims.id }),
      );
      await tx
        .insert(schema.claimEvidence)
        .values({ workspaceId, claimId: claim.id, chunkId: chunk.id });

      const document = only(
        await tx
          .insert(schema.documents)
          .values({ workspaceId, projectId: project.id, title: `مستند ${label}` })
          .returning({ id: schema.documents.id }),
      );
      const version = only(
        await tx
          .insert(schema.documentVersions)
          .values({
            workspaceId,
            documentId: document.id,
            version: 1,
            content: { type: 'doc', content: [] },
          })
          .returning({ id: schema.documentVersions.id }),
      );
      await tx.insert(schema.citations).values({
        workspaceId,
        documentId: document.id,
        sourceId: source.id,
        chunkId: chunk.id,
      });
      await tx
        .insert(schema.literatureMatrixRows)
        .values({ workspaceId, projectId: project.id, sourceId: source.id });
      await tx.insert(schema.exports).values({
        workspaceId,
        documentId: document.id,
        documentVersionId: version.id,
        format: 'docx',
      });

      await tx.insert(schema.subscriptions).values({ workspaceId, planId });
      await tx.insert(schema.usageCounters).values({
        workspaceId,
        metric: 'chat_messages',
        periodStart: '2026-01-01',
        periodEnd: '2026-02-01',
        used: 1,
      });
      await tx.insert(schema.auditLog).values({
        workspaceId,
        actorUserId: user.id,
        action: 'project.created',
        entityType: 'project',
        entityId: project.id,
      });

      return {
        userId: user.id,
        workspaceId,
        projectId: project.id,
        sourceId: source.id,
        fileId: file.id,
        chunkId: chunk.id,
        documentId: document.id,
        claimId: claim.id,
      };
    },
    { userId: user.id },
  );
}
