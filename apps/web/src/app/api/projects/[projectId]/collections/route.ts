import { createCollection, listCollections } from '@bahith/db';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { projectContext, unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ projectId: string }> };

/** The project's collections with the ids of their sources. Any member. */
export async function GET(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    const collections = await listCollections(getDatabase(), context);
    return Response.json({ collections }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return apiError(error);
  }
}

/** Creates a collection `{ name }` (owner/editor). 409 LIBRARY_NAME_TAKEN for a duplicate. */
export async function POST(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    const collection = await createCollection(getDatabase(), context, await readJsonBody(request));
    return Response.json({ collection }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
