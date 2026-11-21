import { z } from 'zod';

import { ScholarlyError } from '../errors';
import type { HttpResponse } from '../http/client';
import type { Provenance, ScholarlyRecord } from '../types';
import { cslDate, cslItem, cslType, record } from '../util/csl';
import { normalizeDoi, normalizeOrcid } from '../util/ids';
import { cleanText } from '../util/text';
import { baseHeaders, CACHE_TTL, type CallOptions, type ProviderContext } from './common';

const BASE_URL = 'https://pub.orcid.org';
const PROVIDER = 'orcid';

const valueOf = z.object({ value: z.string().nullish() }).nullish();

const personSchema = z.object({
  name: z
    .object({
      'given-names': valueOf,
      'family-name': valueOf,
      'credit-name': valueOf,
    })
    .nullish(),
  'other-names': z
    .object({ 'other-name': z.array(z.object({ content: z.string().nullish() })).nullish() })
    .nullish(),
});

const externalIdsSchema = z
  .object({
    'external-id': z
      .array(
        z.object({
          'external-id-type': z.string(),
          'external-id-value': z.string(),
          'external-id-relationship': z.string().nullish(),
        }),
      )
      .nullish(),
  })
  .nullish();

export const orcidWorkSummarySchema = z.object({
  'put-code': z.number().int(),
  title: z.object({ title: valueOf }).nullish(),
  'external-ids': externalIdsSchema,
  url: valueOf,
  type: z.string().nullish(),
  'publication-date': z.object({ year: valueOf, month: valueOf, day: valueOf }).nullish(),
  'journal-title': valueOf,
});

export type OrcidWorkSummary = z.infer<typeof orcidWorkSummarySchema>;

const worksSchema = z.object({
  group: z.array(z.object({ 'work-summary': z.array(orcidWorkSummarySchema) })),
});

export interface OrcidPerson {
  orcid: string;
  givenNames?: string;
  familyName?: string;
  creditName?: string;
  otherNames: string[];
  provenance: Provenance;
}

function int(value: string | null | undefined): number | undefined {
  return value !== null && value !== undefined && /^\d+$/u.test(value) ? Number(value) : undefined;
}

export function normalizeOrcidWork(
  orcid: string,
  summary: OrcidWorkSummary,
  response: HttpResponse,
): ScholarlyRecord {
  const ids = summary['external-ids']?.['external-id'] ?? [];
  const doiId = ids.find(
    (id) =>
      id['external-id-type'].toLowerCase() === 'doi' &&
      (id['external-id-relationship'] ?? 'self') === 'self',
  );
  const doi = doiId === undefined ? undefined : normalizeDoi(doiId['external-id-value']);
  const date = summary['publication-date'];
  const providerId = `${orcid}/work/${summary['put-code']}`;
  const item = cslItem({
    id: `orcid:${providerId}`,
    type: cslType(summary.type),
    title: cleanText(summary.title?.title?.value),
    issued: cslDate(int(date?.year?.value), int(date?.month?.value), int(date?.day?.value)),
    'container-title': cleanText(summary['journal-title']?.value),
    DOI: doi,
    URL:
      cleanText(summary.url?.value) ?? (doi === undefined ? undefined : `https://doi.org/${doi}`),
  });
  return record(PROVIDER, providerId, item, response);
}

/** ORCID public API v3.0 client (read-only public data, no token needed). */
export class OrcidClient {
  constructor(private readonly ctx: ProviderContext) {}

  private request(orcidInput: string, section: 'person' | 'works', options: CallOptions) {
    const orcid = normalizeOrcid(orcidInput);
    if (orcid === undefined)
      throw new ScholarlyError('SCHOLARLY_INVALID_INPUT', { provider: PROVIDER });
    return {
      orcid,
      request: {
        provider: PROVIDER,
        url: new URL(`/v3.0/${orcid}/${section}`, BASE_URL),
        headers: baseHeaders(this.ctx.config, 'application/json'),
        cacheTtlMs: CACHE_TTL.record,
        notFoundTtlMs: CACHE_TTL.notFound,
        ...options,
      } as const,
    };
  }

  /** Public name data. Throws SCHOLARLY_INVALID_INPUT for a malformed iD or bad checksum. */
  async getPerson(orcidInput: string, options: CallOptions = {}): Promise<OrcidPerson> {
    const { orcid, request } = this.request(orcidInput, 'person', options);
    const { data, response } = await this.ctx.http.getJson(request, personSchema);
    const person: OrcidPerson = {
      orcid,
      otherNames: (data['other-names']?.['other-name'] ?? [])
        .map((entry) => cleanText(entry.content))
        .filter((name): name is string => name !== undefined),
      provenance: {
        provider: PROVIDER,
        providerId: orcid,
        fetchedAt: response.receivedAt.toISOString(),
        url: response.url,
      },
    };
    const given = cleanText(data.name?.['given-names']?.value);
    const family = cleanText(data.name?.['family-name']?.value);
    const credit = cleanText(data.name?.['credit-name']?.value);
    if (given !== undefined) person.givenNames = given;
    if (family !== undefined) person.familyName = family;
    if (credit !== undefined) person.creditName = credit;
    return person;
  }

  /** Public works, one record per work group (ORCID's first, preferred summary). */
  async getWorks(orcidInput: string, options: CallOptions = {}): Promise<ScholarlyRecord[]> {
    const { orcid, request } = this.request(orcidInput, 'works', options);
    const { data, response } = await this.ctx.http.getJson(request, worksSchema);
    return data.group
      .map((group) => group['work-summary'][0])
      .filter((summary): summary is OrcidWorkSummary => summary !== undefined)
      .map((summary) => normalizeOrcidWork(orcid, summary, response));
  }
}
