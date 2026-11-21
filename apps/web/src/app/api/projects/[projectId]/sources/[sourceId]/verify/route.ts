import { applySourceVerification, listProjectSourceMetadata, SanadError } from '@bahith/db';
import { isScholarlyError, verifyReference } from '@bahith/scholarly';
import { z } from 'zod';

import { apiError, readJsonBody, requireSameOrigin } from '@/server/api';
import { getDatabase } from '@/server/db';
import { projectContext, requireProjectAccess, unauthenticated } from '@/server/project-context';
import { cslToRecord, getScholarly } from '@/server/scholarly';

type Params = { params: Promise<{ projectId: string; sourceId: string }> };

const bodySchema = z.strictObject({ doi: z.string().trim().max(300).optional() });

/**
 * Checks a source against Crossref (and OpenAlex) to catch fabricated or mistaken
 * references. Only a positive match marks it verified; when the registries cannot be
 * reached nothing is recorded and the client is told so.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const context = await projectContext(request, params);
    if (context === null) return unauthenticated();
    requireSameOrigin(request);
    await requireProjectAccess(context, true);
    const body = bodySchema.safeParse(await readJsonBody(request));
    const sourceId = z.uuid().safeParse((await params).sourceId);
    if (!body.success || !sourceId.success) throw new SanadError('SANAD_INVALID_INPUT');
    const database = getDatabase();
    const [source] = await listProjectSourceMetadata(database, context, sourceId.data);
    if (source === undefined) throw new SanadError('SANAD_SOURCE_MISMATCH');

    const doi = body.data.doi === undefined || body.data.doi === '' ? source.doi : body.data.doi;
    const scholarly = getScholarly();
    const result = await verifyReference(
      {
        ...(doi === null ? {} : { doi }),
        title: source.title,
        authors: source.authors,
        ...(source.year === null ? {} : { year: source.year }),
        ...(source.containerTitle === null ? {} : { container: source.containerTitle }),
      },
      { crossref: scholarly.crossref, openalex: scholarly.openalex },
    );
    if (result.status === 'unverifiable') {
      return Response.json(
        { code: 'VERIFICATION_UNAVAILABLE', reasons: result.reasons },
        { status: 503 },
      );
    }
    const provider = result.provider ?? null;
    if (result.status === 'verified') {
      const record =
        result.matchedRecord === undefined ? null : cslToRecord(result.matchedRecord.item);
      if (record === null || provider === null) {
        return Response.json({ code: 'VERIFICATION_UNAVAILABLE' }, { status: 503 });
      }
      await applySourceVerification(database, context, sourceId.data, {
        status: 'verified',
        provider,
        record,
      });
    } else {
      await applySourceVerification(database, context, sourceId.data, {
        status: result.status,
        provider,
      });
    }
    return Response.json({ status: result.status, reasons: result.reasons, checks: result.checks });
  } catch (error) {
    if (isScholarlyError(error)) {
      return Response.json(
        {
          code:
            error.code === 'SCHOLARLY_CONFIG_MISSING'
              ? 'SCHOLARLY_NOT_CONFIGURED'
              : error.code === 'SCHOLARLY_INVALID_INPUT'
                ? 'VERIFICATION_NEEDS_DOI_OR_TITLE'
                : 'VERIFICATION_UNAVAILABLE',
        },
        { status: error.code === 'SCHOLARLY_INVALID_INPUT' ? 400 : 503 },
      );
    }
    return apiError(error);
  }
}
