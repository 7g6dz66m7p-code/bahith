import type { RegistryRecord } from '@bahith/db';
import type { CslItem, ScholarlyClients } from '@bahith/scholarly';
import { createScholarlyClients, loadScholarlyConfig } from '@bahith/scholarly';

const holder = globalThis as typeof globalThis & { __bahithScholarly?: ScholarlyClients };

/**
 * Clients for Crossref, OpenAlex, … configured from the environment. Calls that need the
 * contact email fail with SCHOLARLY_CONFIG_MISSING when it is not set — never anonymously.
 */
export function getScholarly(): ScholarlyClients {
  holder.__bahithScholarly ??= createScholarlyClients(loadScholarlyConfig(process.env));
  return holder.__bahithScholarly;
}

function str(value: unknown, max: number): string | null {
  if (typeof value === 'number') return String(value).slice(0, max);
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;
}

/** A CSL-JSON item (from a registry or a BibTeX/RIS file) as stored source metadata. */
export function cslToRecord(item: CslItem | Record<string, unknown>): RegistryRecord | null {
  const value = item as Record<string, unknown>;
  const title = str(value.title, 2000);
  if (title === null) return null;
  const names = Array.isArray(value.author) ? value.author : [];
  const authors = names.flatMap((name: unknown) => {
    if (typeof name !== 'object' || name === null) return [];
    const record = name as Record<string, unknown>;
    const family = str(record.family, 200);
    const given = str(record.given, 200);
    const literal = str(record.literal, 300);
    return family === null && literal === null
      ? []
      : [
          {
            ...(family === null ? {} : { family }),
            ...(given === null ? {} : { given }),
            ...(literal === null ? {} : { literal }),
          },
        ];
  });
  const issued = value.issued as { 'date-parts'?: unknown[][] } | undefined;
  const rawYear = issued?.['date-parts']?.[0]?.[0];
  const year =
    typeof rawYear === 'number'
      ? rawYear
      : typeof rawYear === 'string'
        ? Number.parseInt(rawYear, 10)
        : Number.NaN;
  const url = str(value.URL, 2000);
  return {
    type: str(value.type, 64) ?? 'document',
    title,
    authors,
    year: Number.isInteger(year) && year > 0 && year < 3000 ? year : null,
    containerTitle: str(value['container-title'], 1000),
    publisher: str(value.publisher, 500),
    volume: str(value.volume, 64),
    issue: str(value.issue, 64),
    pages: str(value.page, 64),
    doi: str(value.DOI, 300)?.toLowerCase() ?? null,
    url: url !== null && /^https?:\/\//u.test(url) ? url : null,
    language: str(value.language, 35),
    abstract: str(value.abstract, 20_000),
    csl: value,
  };
}

/** Stored source metadata as a CSL-JSON item, for BibTeX/RIS export and citeproc. */
export function recordToCsl(source: {
  sourceId: string;
  type: string;
  title: string;
  authors: { family?: string; given?: string; literal?: string }[];
  year: number | null;
  containerTitle: string | null;
  publisher: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  url: string | null;
  language: string | null;
}): Record<string, unknown> {
  return {
    id: source.sourceId,
    type: source.type,
    title: source.title,
    ...(source.authors.length > 0 ? { author: source.authors } : {}),
    ...(source.year === null ? {} : { issued: { 'date-parts': [[source.year]] } }),
    ...(source.containerTitle === null ? {} : { 'container-title': source.containerTitle }),
    ...(source.publisher === null ? {} : { publisher: source.publisher }),
    ...(source.volume === null ? {} : { volume: source.volume }),
    ...(source.issue === null ? {} : { issue: source.issue }),
    ...(source.pages === null ? {} : { page: source.pages }),
    ...(source.doi === null ? {} : { DOI: source.doi }),
    ...(source.url === null ? {} : { URL: source.url }),
    ...(source.language === null ? {} : { language: source.language }),
  };
}
