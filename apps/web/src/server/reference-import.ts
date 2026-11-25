import { addReferenceSource } from '@bahith/db';
import type { CslItem } from '@bahith/citations';

import { getDatabase } from './db';
import type { ProjectRequestContext } from './project-context';
import { cslToRecord } from './scholarly';

/** Most entries one import adds; the rest are reported as skipped. */
export const MAX_IMPORT_ENTRIES = 2_000;

export interface ImportCounts {
  added: number;
  duplicates: number;
  skipped: number;
}

/**
 * Adds imported CSL items (BibTeX, RIS, CSL-JSON, Zotero) to the project as unverified,
 * metadata-only sources through the deduplicating path: the same DOI, or the same title
 * and year, links the existing source instead of creating another. Items without a title
 * are skipped. Nothing imported counts as verified until checked against a registry.
 */
export async function importCslItems(
  context: ProjectRequestContext,
  items: readonly CslItem[],
  alreadySkipped = 0,
): Promise<ImportCounts> {
  const database = getDatabase();
  const counts: ImportCounts = {
    added: 0,
    duplicates: 0,
    skipped: alreadySkipped + Math.max(0, items.length - MAX_IMPORT_ENTRIES),
  };
  for (const item of items.slice(0, MAX_IMPORT_ENTRIES)) {
    const record = cslToRecord(item);
    if (record === null) {
      counts.skipped += 1;
      continue;
    }
    const result = await addReferenceSource(database, context, {
      record,
      origin: 'import',
      verifiedBy: null,
    });
    if (result.duplicate) counts.duplicates += 1;
    else counts.added += 1;
  }
  return counts;
}
