import pg from 'pg';

import type { Entity } from '../canonical';
import { ENTITIES } from '../canonical';
import type { EntityMapping, Mapping, RawRecord } from '../mapping';
import { projectRow } from '../mapping';
import type { LegacySource, ReadOptions } from '../source';

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const quoteTable = (table: string) => table.split('.').map(quote).join('.');

/**
 * Builds the keyset-paginated SELECT for one entity. Identifiers come from the mapping,
 * which `mappingSchema` restricts to `[A-Za-z0-9_]`; they are quoted all the same.
 * Values (cursor, since, limit) are always bind parameters.
 */
export function buildSelect(
  m: EntityMapping,
  options: { afterKey: boolean; since: boolean },
): string {
  const columns = new Set<string>([m.key, ...Object.values(m.fields)]);
  const updatedColumn = m.fields['updatedAt'];
  const where: string[] = [];
  let param = 1;
  if (options.afterKey) where.push(`${quote(m.key)} > $${param++}`);
  if (options.since && updatedColumn !== undefined) {
    where.push(`${quote(updatedColumn)} >= $${param++}`);
  }
  return [
    `SELECT ${[...columns].map(quote).join(', ')} FROM ${quoteTable(m.table)}`,
    where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    `ORDER BY ${quote(m.key)} LIMIT $${param}`,
  ]
    .filter((part) => part !== '')
    .join(' ');
}

export interface PostgresLegacySourceOptions {
  connectionString: string;
  mapping: Mapping;
  batchSize?: number;
}

/**
 * Reads a legacy Postgres (ideally a read-only replica) through a session that is
 * forced read-only on the server side: `default_transaction_read_only=on` and every
 * page is read inside `BEGIN READ ONLY`. Any accidental write fails in Postgres.
 */
export class PostgresLegacySource implements LegacySource {
  readonly kind = 'postgres';
  private readonly pool: pg.Pool;
  private readonly batchSize: number;

  constructor(private readonly options: PostgresLegacySourceOptions) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: 2,
      options: '-c default_transaction_read_only=on -c statement_timeout=60000',
      application_name: 'bahith-migration-readonly',
    });
    this.batchSize = options.batchSize ?? 1000;
  }

  entities(): readonly Entity[] {
    return ENTITIES.filter((e) => this.options.mapping.entities[e] !== undefined);
  }

  async *read(entity: Entity, options: ReadOptions = {}): AsyncIterable<RawRecord> {
    const m = this.options.mapping.entities[entity];
    if (m === undefined) return;
    let cursor: unknown = undefined;
    for (;;) {
      const params: unknown[] = [];
      if (cursor !== undefined) params.push(cursor);
      const since = options.since !== undefined && m.fields['updatedAt'] !== undefined;
      if (since) params.push(options.since);
      params.push(this.batchSize);
      const sql = buildSelect(m, { afterKey: cursor !== undefined, since });

      const client = await this.pool.connect();
      let rows: Record<string, unknown>[];
      try {
        await client.query('BEGIN READ ONLY');
        rows = (await client.query<Record<string, unknown>>(sql, params)).rows;
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      for (const row of rows) yield projectRow(m, row);
      if (rows.length < this.batchSize) return;
      const last = rows[rows.length - 1];
      cursor = last?.[m.key];
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
