import { addReferenceSource } from '@bahith/db';
import type { CslItem } from '@bahith/citations';
import { CitationError, parseBibtex, parseRis } from '@bahith/citations';

import { apiError, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { projectContext, unauthenticated } from '@/server/project-context';
import { cslToRecord } from '@/server/scholarly';

type Params = { params: Promise<{ projectId: string }> };

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/**
 * Imports a BibTeX or RIS file. Entries become unverified, metadata-only sources; they
 * must be verified against a registry before they count as verified references.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const declared = Number(request.headers.get('content-length') ?? 'NaN');
    if (!Number.isFinite(declared) || declared > MAX_IMPORT_BYTES + 64 * 1024) {
      return Response.json({ code: 'IMPORT_TOO_LARGE' }, { status: 413 });
    }
    const file = (await request.formData().catch(() => null))?.get('file');
    if (!(file instanceof File) || file.size === 0 || file.size > MAX_IMPORT_BYTES) {
      return Response.json({ code: 'IMPORT_MISSING' }, { status: 400 });
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      return Response.json({ code: 'IMPORT_NOT_UTF8' }, { status: 400 });
    }
    const isRis = /^\s*TY\s{2}-/mu.test(text);
    let items: readonly CslItem[];
    try {
      items = isRis ? parseRis(text) : parseBibtex(text);
    } catch (error) {
      if (error instanceof CitationError) {
        return Response.json({ code: 'IMPORT_UNREADABLE' }, { status: 422 });
      }
      throw error;
    }
    const database = getDatabase();
    let added = 0;
    let duplicates = 0;
    let skipped = 0;
    for (const item of items.slice(0, 2_000)) {
      const record = cslToRecord(item);
      if (record === null) {
        skipped += 1;
        continue;
      }
      const result = await addReferenceSource(database, context, {
        record,
        origin: 'import',
        verifiedBy: null,
      });
      if (result.duplicate) duplicates += 1;
      else added += 1;
    }
    return Response.json({ format: isRis ? 'ris' : 'bibtex', added, duplicates, skipped });
  } catch (error) {
    return apiError(error);
  }
}
