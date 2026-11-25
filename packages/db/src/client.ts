import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { z } from 'zod';

import { DbError } from './errors';
import * as schema from './schema/index';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
/** A transaction bound to a workspace and/or user by `withWorkspace` / `withUser`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const uuidSchema = z.uuid();

function parseUuid(value: string, what: 'workspace' | 'user'): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new DbError('DB_INVALID_CONTEXT', `Invalid ${what} id: expected a UUID.`);
  }
  return parsed.data;
}

export interface WithWorkspaceOptions {
  /** The authenticated user acting inside the workspace. */
  userId?: string;
}

export interface Database {
  /**
   * The raw Drizzle handle. Queries issued here run with NO workspace bound, so
   * row-level security hides every tenant row. Use it only for global tables.
   */
  readonly db: Db;
  readonly pool: pg.Pool;
  /**
   * Runs `fn` in a transaction bound to one workspace: `app.workspace_id` is set with
   * transaction scope (the equivalent of `SET LOCAL`), so row-level security exposes
   * that workspace's rows only, and the binding ends with the transaction.
   */
  withWorkspace<T>(
    workspaceId: string,
    fn: (tx: Tx) => Promise<T>,
    options?: WithWorkspaceOptions,
  ): Promise<T>;
  /**
   * Runs `fn` in a transaction bound to a user but to no workspace. It can see only the
   * user's own memberships and the workspaces they belong to — used to resolve which
   * workspace a request may enter.
   */
  withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface CreateDatabaseOptions {
  /** Connection string of the application role (never the admin/owner role). */
  connectionString: string;
  /** Maximum pool size. */
  max?: number;
}

export function createDatabase(options: CreateDatabaseOptions): Database {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
  });
  // An idle client can fail (e.g. the server restarts). Without a listener Node would
  // crash the process; the pool already discards the broken client.
  pool.on('error', () => undefined);

  const db = drizzle(pool, { schema });

  const bind = <T>(workspaceId: string, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => {
      // set_config(..., true) is the parameterisable form of SET LOCAL. Both settings
      // are always written so nothing can be inherited from the pooled connection.
      await tx.execute(
        sql`select set_config('app.workspace_id', ${workspaceId}, true),
                   set_config('app.user_id', ${userId}, true)`,
      );
      return fn(tx);
    });

  return {
    db,
    pool,
    // Both are `async` so an invalid id surfaces as a rejected promise, never a sync throw.
    async withWorkspace(workspaceId, fn, withOptions = {}) {
      const workspace = parseUuid(workspaceId, 'workspace');
      const user = withOptions.userId === undefined ? '' : parseUuid(withOptions.userId, 'user');
      return bind(workspace, user, fn);
    },
    async withUser(userId, fn) {
      return bind('', parseUuid(userId, 'user'), fn);
    },
    async close() {
      await pool.end();
    },
  };
}
