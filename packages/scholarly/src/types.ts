export const PROVIDER_IDS = [
  'crossref',
  'openalex',
  'semanticscholar',
  'pubmed',
  'arxiv',
  'doaj',
  'orcid',
  'unpaywall',
  'zotero',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Subset of CSL 1.0.2 item types that the providers map to. */
export type CslType =
  | 'article'
  | 'article-journal'
  | 'article-magazine'
  | 'article-newspaper'
  | 'book'
  | 'chapter'
  | 'dataset'
  | 'document'
  | 'entry'
  | 'entry-dictionary'
  | 'entry-encyclopedia'
  | 'paper-conference'
  | 'report'
  | 'review'
  | 'software'
  | 'standard'
  | 'thesis'
  | 'webpage';

/** A CSL-JSON name. Providers that only return a display name fill `literal`. */
export interface CslName {
  family?: string;
  given?: string;
  literal?: string;
}

export type CslDateParts = [number] | [number, number] | [number, number, number];

export interface CslDate {
  'date-parts': [CslDateParts];
}

/** CSL-JSON item (the fields BAHITH uses). Built by code from upstream metadata only. */
export interface CslItem {
  id: string;
  type: CslType;
  title?: string;
  author?: CslName[];
  issued?: CslDate;
  'container-title'?: string;
  volume?: string;
  issue?: string;
  page?: string;
  DOI?: string;
  ISBN?: string;
  ISSN?: string;
  URL?: string;
  publisher?: string;
  language?: string;
  abstract?: string;
}

/** Where a record came from. `url` never contains the contact email or API keys. */
export interface Provenance {
  provider: ProviderId;
  providerId: string;
  /** ISO-8601 instant at which the upstream response was received. */
  fetchedAt: string;
  url: string;
}

export interface ScholarlyRecord {
  item: CslItem;
  provenance: Provenance;
}

export interface SearchResult {
  /** Total hits reported by the provider, or null when it does not report one. */
  total: number | null;
  records: ScholarlyRecord[];
}
