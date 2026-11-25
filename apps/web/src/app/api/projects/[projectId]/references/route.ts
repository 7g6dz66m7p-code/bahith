import { addReferenceSource, listProjectSourceMetadata, SanadError } from '@bahith/db';
import type { CslItem } from '@bahith/scholarly';
import { isScholarlyError, normalizeDoi } from '@bahith/scholarly';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { projectContext, requireProjectAccess, unauthenticated } from '@/server/project-context';
import { cslToRecord, getScholarly } from '@/server/scholarly';

type Params = { params: Promise<{ projectId: string }> };

const bodySchema = z.strictObject({ doi: z.string().trim().min(1).max(300) });

/** Every source attached to the project with its bibliographic metadata and verification. */
export async function GET(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    const references = await listProjectSourceMetadata(getDatabase(), context);
    return Response.json({ references }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return apiError(error);
  }
}

/** Adds a reference by DOI: the record is fetched from Crossref (else OpenAlex). */
export async function POST(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    await requireProjectAccess(context, true);
    const body = bodySchema.safeParse(await readJsonBody(request));
    if (!body.success) throw new SanadError('SANAD_INVALID_INPUT');
    const doi = normalizeDoi(body.data.doi);
    if (doi === undefined) return Response.json({ code: 'DOI_MALFORMED' }, { status: 400 });

    const scholarly = getScholarly();
    let found: { item: CslItem; provider: string } | null = null;
    for (const [provider, lookup] of [
      ['crossref', () => scholarly.crossref.getWork(doi)],
      ['openalex', () => scholarly.openalex.getWorkByDoi(doi)],
    ] as const) {
      try {
        const record = await lookup();
        found = { item: record.item, provider };
        break;
      } catch (error) {
        if (!(isScholarlyError(error) && error.code === 'SCHOLARLY_NOT_FOUND')) throw error;
      }
    }
    if (found === null) return Response.json({ code: 'DOI_NOT_FOUND' }, { status: 404 });
    const record = cslToRecord(found.item);
    if (record === null) return Response.json({ code: 'DOI_NOT_FOUND' }, { status: 404 });
    const added = await addReferenceSource(getDatabase(), context, {
      record,
      origin: 'search',
      verifiedBy: found.provider,
    });
    return Response.json(
      { reference: added, provider: found.provider },
      { status: added.duplicate ? 200 : 201 },
    );
  } catch (error) {
    if (isScholarlyError(error)) {
      return Response.json(
        {
          code:
            error.code === 'SCHOLARLY_CONFIG_MISSING'
              ? 'SCHOLARLY_NOT_CONFIGURED'
              : 'REGISTRY_UNAVAILABLE',
        },
        { status: 503 },
      );
    }
    return apiError(error);
  }
}
