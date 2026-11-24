import { deleteHighlight, updateHighlightNote } from '@bahith/db';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { projectContext, unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ projectId: string; highlightId: string }> };

/** Changes or clears the note `{ note }`: its author (owner/editor), or the owner. */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const { highlightId } = await params;
    const highlight = await updateHighlightNote(
      getDatabase(),
      context,
      highlightId,
      await readJsonBody(request),
    );
    return Response.json({ highlight });
  } catch (error) {
    return apiError(error);
  }
}

/** Deletes a highlight and its note (owner/editor). */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const { highlightId } = await params;
    await deleteHighlight(getDatabase(), context, highlightId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
}
