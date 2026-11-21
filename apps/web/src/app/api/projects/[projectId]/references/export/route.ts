import { listProjectSourceMetadata, SanadError } from '@bahith/db';
import { toBibtex, toRis } from '@bahith/citations';
import { z } from 'zod';

import { apiError } from '@/server/api';
import { getDatabase } from '@/server/db';
import { projectContext, unauthenticated } from '@/server/project-context';
import { recordToCsl } from '@/server/scholarly';

type Params = { params: Promise<{ projectId: string }> };

/** The project's references as BibTeX or RIS, built from stored metadata. */
export async function GET(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    const format = z
      .enum(['bibtex', 'ris'])
      .safeParse(new URL(request.url).searchParams.get('format'));
    if (!format.success) throw new SanadError('SANAD_INVALID_INPUT');
    const items = (await listProjectSourceMetadata(getDatabase(), context)).map(recordToCsl);
    const text =
      items.length === 0 ? '' : format.data === 'bibtex' ? toBibtex(items) : toRis(items);
    const extension = format.data === 'bibtex' ? 'bib' : 'ris';
    return new Response(text, {
      headers: {
        'Content-Type':
          format.data === 'bibtex'
            ? 'application/x-bibtex; charset=utf-8'
            : 'application/x-research-info-systems; charset=utf-8',
        'Content-Disposition': `attachment; filename="references.${extension}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
