import { addHighlight, listHighlights, SanadError } from '@bahith/db';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { projectContext, unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ projectId: string }> };

/** The project's highlights (optionally `?sourceId=` one source), newest first. Any member. */
export async function GET(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    const raw = new URL(request.url).searchParams.get('sourceId');
    const sourceId = raw === null ? null : z.uuid().safeParse(raw);
    if (sourceId !== null && !sourceId.success) throw new SanadError('SANAD_INVALID_INPUT');
    const highlights = await listHighlights(
      getDatabase(),
      context,
      sourceId === null ? {} : { sourceId: sourceId.data },
    );
    return Response.json({ highlights }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return apiError(error);
  }
}

/**
 * Highlights `{ chunkId, charStart, charEnd, quote, note?, color? }` (owner/editor). 422
 * HIGHLIGHT_QUOTE_MISMATCH unless `quote` is exactly the stored passage between the
 * code-point offsets; 404 LIBRARY_NOT_FOUND for a passage outside this project.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const highlight = await addHighlight(getDatabase(), context, await readJsonBody(request));
    return Response.json({ highlight }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
