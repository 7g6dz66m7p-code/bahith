import { z } from 'zod';

import { requireContactEmail } from '../config';
import { ScholarlyError } from '../errors';
import type { Provenance } from '../types';
import { normalizeDoi } from '../util/ids';
import { cleanText } from '../util/text';
import {
  baseHeaders,
  CACHE_TTL,
  type CallOptions,
  optString,
  type ProviderContext,
} from './common';

const BASE_URL = 'https://api.unpaywall.org';
const PROVIDER = 'unpaywall';

const locationSchema = z.object({
  url: optString,
  url_for_pdf: optString,
  url_for_landing_page: optString,
  license: optString,
  version: optString,
  host_type: optString,
});

const responseSchema = z.object({
  doi: z.string(),
  is_oa: z.boolean(),
  oa_status: optString,
  best_oa_location: locationSchema.nullish(),
});

export interface OpenAccessLocation {
  url: string;
  pdfUrl: string | null;
  landingPageUrl: string | null;
  /** As reported by Unpaywall (e.g. `cc-by`, `other-oa`), or null when it reports none. */
  license: string | null;
  /** `publishedVersion` | `acceptedVersion` | `submittedVersion`, as reported. */
  version: string | null;
  /** `publisher` | `repository`, as reported. */
  hostType: string | null;
}

/**
 * Open-access status exactly as Unpaywall reports it. `bestLocation` is null when Unpaywall
 * knows no OA copy: that is not a statement that the full text is unavailable elsewhere, and
 * a non-null location is Unpaywall's claim, not a check this package performed.
 */
export interface OpenAccessResult {
  doi: string;
  isOa: boolean;
  oaStatus: string | null;
  bestLocation: OpenAccessLocation | null;
  provenance: Provenance;
}

/** Unpaywall REST API v2 client. Requires the contact email on every call. */
export class UnpaywallClient {
  constructor(private readonly ctx: ProviderContext) {}

  async getOpenAccess(doiInput: string, options: CallOptions = {}): Promise<OpenAccessResult> {
    const doi = normalizeDoi(doiInput);
    if (doi === undefined)
      throw new ScholarlyError('SCHOLARLY_INVALID_INPUT', { provider: PROVIDER });
    const email = requireContactEmail(this.ctx.config, PROVIDER);
    const url = new URL(`/v2/${doi.split('/').map(encodeURIComponent).join('/')}`, BASE_URL);
    url.searchParams.set('email', email);
    const { data, response } = await this.ctx.http.getJson(
      {
        provider: PROVIDER,
        url,
        headers: baseHeaders(this.ctx.config),
        cacheTtlMs: CACHE_TTL.openAccess,
        notFoundTtlMs: CACHE_TTL.notFound,
        ...options,
      },
      responseSchema,
    );
    const best = data.best_oa_location;
    const bestUrl =
      cleanText(best?.url) ?? cleanText(best?.url_for_pdf) ?? cleanText(best?.url_for_landing_page);
    return {
      doi: normalizeDoi(data.doi) ?? doi,
      isOa: data.is_oa,
      oaStatus: cleanText(data.oa_status) ?? null,
      bestLocation:
        best === null || best === undefined || bestUrl === undefined
          ? null
          : {
              url: bestUrl,
              pdfUrl: cleanText(best.url_for_pdf) ?? null,
              landingPageUrl: cleanText(best.url_for_landing_page) ?? null,
              license: cleanText(best.license) ?? null,
              version: cleanText(best.version) ?? null,
              hostType: cleanText(best.host_type) ?? null,
            },
      provenance: {
        provider: PROVIDER,
        providerId: doi,
        fetchedAt: response.receivedAt.toISOString(),
        url: response.url,
      },
    };
  }
}
