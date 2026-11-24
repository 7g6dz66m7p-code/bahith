import { deleteCollection, renameCollection } from '@bahith/db';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { projectContext, unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ projectId: string; collectionId: string }> };

/** Renames a collection `{ name }` (owner/editor). */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const { collectionId } = await params;
    const collection = await renameCollection(
      getDatabase(),
      context,
      collectionId,
      await readJsonBody(request),
    );
    return Response.json({ collection });
  } catch (error) {
    return apiError(error);
  }
}

/** Deletes a collection (owner/editor); its sources stay in the library. */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const { collectionId } = await params;
    await deleteCollection(getDatabase(), context, collectionId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
}
