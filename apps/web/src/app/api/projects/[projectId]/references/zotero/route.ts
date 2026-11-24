import { zoteroCredentialsSchema } from '@bahith/scholarly';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { projectContext, requireProjectAccess, unauthenticated } from '@/server/project-context';
import { importCslItems } from '@/server/reference-import';
import { getScholarly } from '@/server/scholarly';
import { cslItemsFromZotero, ZOTERO_IMPORT_TIMEOUT_MS, zoteroFailure } from '@/server/zotero';

type Params = { params: Promise<{ projectId: string }> };

/**
 * One-off import of a Zotero user library through the Zotero Web API. The user ID and API
 * key come from the form for this request only: they are not stored, logged or echoed.
 * Items become unverified, metadata-only sources through the same deduplicating path as
 * file imports.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    await requireProjectAccess(context, true);
    const credentials = zoteroCredentialsSchema.safeParse(await readJsonBody(request));
    if (!credentials.success) {
      return Response.json({ code: 'ZOTERO_INVALID_CREDENTIALS' }, { status: 400 });
    }
    const library = await getScholarly().zotero.listUserItems(credentials.data, {
      signal: AbortSignal.timeout(ZOTERO_IMPORT_TIMEOUT_MS),
    });
    const { items, invalid } = cslItemsFromZotero(library);
    return Response.json({
      format: 'zotero',
      truncated: library.truncated,
      ...(await importCslItems(context, items, invalid)),
    });
  } catch (error) {
    const failure = zoteroFailure(error);
    if (failure !== null) return Response.json({ code: failure.code }, { status: failure.status });
    return apiError(error);
  }
}
