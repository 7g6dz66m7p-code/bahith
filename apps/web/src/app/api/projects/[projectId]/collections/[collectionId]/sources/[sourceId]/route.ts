import { addSourceToCollection, removeSourceFromCollection } from '@bahith/db';

import { apiError, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { projectContext, unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ projectId: string; collectionId: string; sourceId: string }> };

/**
 * Puts a source of the project's library into the collection (owner/editor). 400
 * SANAD_SOURCE_MISMATCH when the source is not attached to this project.
 */
export async function PUT(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const { collectionId, sourceId } = await params;
    return Response.json(
      await addSourceToCollection(getDatabase(), context, collectionId, sourceId),
    );
  } catch (error) {
    return apiError(error);
  }
}

/** Takes the source out of the collection (owner/editor). */
export async function DELETE(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const { collectionId, sourceId } = await params;
    return Response.json(
      await removeSourceFromCollection(getDatabase(), context, collectionId, sourceId),
    );
  } catch (error) {
    return apiError(error);
  }
}
