import { listDocumentVersions } from '@bahith/db';

import { apiError } from '@/server/api';
import { getDatabase } from '@/server/db';
import { projectContext, unauthenticated } from '@/server/project-context';

type Params = { params: Promise<{ projectId: string; documentId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    return Response.json({
      versions: await listDocumentVersions(getDatabase(), context, (await params).documentId),
    });
  } catch (error) {
    return apiError(error);
  }
}
