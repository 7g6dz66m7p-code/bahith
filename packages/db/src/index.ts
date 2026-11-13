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
