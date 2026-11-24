import type { CslItem } from '@bahith/citations';
import {
  CitationError,
  detectInterchangeFormat,
  parseBibtex,
  parseCslJson,
  parseRis,
} from '@bahith/citations';

import { apiError, requireSameOrigin } from '@/server/api';
import { projectContext, requireProjectAccess, unauthenticated } from '@/server/project-context';
import { importCslItems } from '@/server/reference-import';

type Params = { params: Promise<{ projectId: string }> };

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/**
 * Imports a BibTeX, RIS or CSL-JSON file (Zotero's "CSL JSON" export included). Entries
 * become unverified, metadata-only sources; they must be verified against a registry
 * before they count as verified references.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    await requireProjectAccess(context, true);
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
    const format = detectInterchangeFormat(text);
    let items: readonly CslItem[];
    let invalid = 0;
    try {
      if (format === 'csl-json') {
        ({ items, invalid } = parseCslJson(text));
      } else {
        items = format === 'ris' ? parseRis(text) : parseBibtex(text);
      }
    } catch (error) {
      if (error instanceof CitationError) {
        return Response.json({ code: 'IMPORT_UNREADABLE' }, { status: 422 });
      }
      throw error;
    }
    return Response.json({ format, ...(await importCslItems(context, items, invalid)) });
  } catch (error) {
    return apiError(error);
  }
}
