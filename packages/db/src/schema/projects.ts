import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, id, tenantExtras, updatedAt } from './_shared';
import { citationStyleEnum, localeEnum, projectStatusEnum, researchPlanStatusEnum } from './enums';
import { userRef, workspaceIdColumn } from './identity';

export const projects = pgTable(
  'projects',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    title: text('title').notNull(),
    researchQuestion: text('research_question'),
    citationStyle: citationStyleEnum('citation_style').notNull().default('apa-7'),
    language: localeEnum('language').notNull().default('ar'),
    status: projectStatusEnum('status').notNull().default('active'),
    createdBy: userRef('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [...tenantExtras('projects', t), index('projects_workspace_id_idx').on(t.workspaceId)],
);

/** Versioned research plan: rows are immutable, a new version is a new row. */
export const researchPlans = pgTable(
  'research_plans',
  {
    id: id(),
    workspaceId: workspaceIdColumn(),
    projectId: uuid('project_id').notNull(),
    version: integer('version').notNull(),
    status: researchPlanStatusEnum('status').notNull().default('draft'),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    createdBy: userRef('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    ...tenantExtras('research_plans', t),
    unique('research_plans_project_id_version_key').on(t.projectId, t.version),
    foreignKey({
      name: 'research_plans_project_fk',
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }).onDelete('cascade'),
  ],
);
