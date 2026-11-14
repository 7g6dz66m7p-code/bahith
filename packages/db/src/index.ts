export { createDatabase } from './client';
export type {
  CreateDatabaseOptions,
  Database,
  Db,
  Schema,
  Tx,
  WithWorkspaceOptions,
} from './client';
export { DbError } from './errors';
export type { DbErrorCode } from './errors';
export { arabicTsQuery } from './search';
export * as schema from './schema/index';
export { withSanadProject } from './sanad/access';
export type { SanadProjectContext } from './sanad/access';
export { SanadError } from './sanad/errors';
export type { SanadErrorCode } from './sanad/errors';
export { ingestExtraction } from './sanad/ingest';
export type { IngestExtractionInput } from './sanad/ingest';
export { parseExtractionManifest, extractionManifestSchema } from './sanad/manifest';
export type { ExtractionManifest } from './sanad/manifest';
export { retrieve, sanadRetrieveSchema } from './sanad/retrieve';
export type { SanadRetrieveInput, SanadRetrieveResult, SanadEvidence } from './sanad/retrieve';
