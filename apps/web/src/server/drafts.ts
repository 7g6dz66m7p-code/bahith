import type { CitationTarget, Database } from '@bahith/db';
import { getDocument, getProjectForUser, resolveCitationTargets } from '@bahith/db';
import { formatBibliography, formatCitation } from '@bahith/citations';
import type { ExportFormat, ExportResult } from '@bahith/export';
import { exportDocument } from '@bahith/export';

import type { DraftNode } from './draft-export';
import { recordToCsl } from './scholarly';
import { collectCitations, draftToExportDocument, targetKey } from './draft-export';

function cslItem(target: CitationTarget): Record<string, unknown> {
  return recordToCsl({ sourceId: target.sourceId, ...target.source });
}

const BIBLIOGRAPHY_HEADING = { ar: 'المصادر والمراجع', en: 'References' } as const;

export interface DraftExport extends ExportResult {
  /** Cited sources that are not verified against an external registry yet. */
  unverifiedSources: number;
}

/**
 * Exports a draft. Citations and the bibliography are produced by the citation engine
 * from stored source records and passage pages, in the project's citation style.
 */
export async function exportDraft(
  database: Database,
  context: { userId: string; workspaceId: string; projectId: string },
  documentId: string,
  format: ExportFormat,
  author: string,
): Promise<DraftExport> {
  const [project, draft] = await Promise.all([
    getProjectForUser(database, context.userId, context.workspaceId, context.projectId),
    getDocument(database, context, documentId),
  ]);
  const doc = draft.content as unknown as DraftNode;
  const refs = collectCitations(doc);
  const resolved = await resolveCitationTargets(database, context, refs);
  // resolveCitationTargets answers in the order of `refs`.
  const targets = new Map<string, CitationTarget>();
  refs.forEach((ref, index) => {
    const target = resolved[index];
    if (target !== undefined) targets.set(targetKey(ref), target);
  });

  const uniqueSources = new Map(resolved.map((target) => [target.sourceId, target]));
  const items = [...uniqueSources.values()].map(cslItem);
  const style = project.citationStyle;
  const locale = project.language;

  const bibliography =
    items.length === 0
      ? []
      : formatBibliography(items, { style, locale, format: 'text' }).entries.map(
          (entry) => entry.output,
        );

  const exportInput = draftToExportDocument({
    doc,
    title: draft.title,
    author,
    language: locale,
    bibliographyHeading: BIBLIOGRAPHY_HEADING[locale],
    bibliography,
    targets,
    formatCitation: (target) => {
      const page = target.chunk?.pageStart ?? null;
      return formatCitation(
        {
          itemIds: [target.sourceId],
          ...(page === null
            ? {}
            : { locators: [{ id: target.sourceId, locator: String(page), label: 'page' }] }),
        },
        items,
        { style, locale, format: 'text' },
      );
    },
  });
  const result = await exportDocument(exportInput, format);
  return {
    ...result,
    unverifiedSources: [...uniqueSources.values()].filter(
      (target) => target.source.verificationStatus !== 'verified',
    ).length,
  };
}
