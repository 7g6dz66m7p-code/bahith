import mysql from 'mysql2/promise';

import type { Entity } from '../canonical';
import { ENTITIES } from '../canonical';
import type { EntityMapping, Mapping, RawRecord } from '../mapping';
import { projectRow } from '../mapping';
import type { LegacySource, ReadOptions } from '../source';

const quote = (name: string) => `\`${name.replace(/`/g, '``')}\``;
const quoteTable = (table: string) => table.split('.').map(quote).join('.');

/** Keyset-paginated SELECT for MySQL/MariaDB; identifiers quoted, values bound. */
export function buildMysqlSelect(
  m: EntityMapping,
  options: { afterKey: boolean; since: boolean },
): string {
  const columns = new Set<string>([m.key, ...Object.values(m.fields)]);
  const updatedColumn = m.fields['updatedAt'];
  const where: string[] = [];
  if (options.afterKey) where.push(`${quote(m.key)} > ?`);
  if (options.since && updatedColumn !== undefined) where.push(`${quote(updatedColumn)} >= ?`);
  return [
    `SELECT ${[...columns].map(quote).join(', ')} FROM ${quoteTable(m.table)}`,
    where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    `ORDER BY ${quote(m.key)} LIMIT ?`,
  ]
    .filter((part) => part !== '')
    .join(' ');
}

export interface MysqlLegacySourceOptions {
  connectionString: string;
  mapping: Mapping;
  batchSize?: number;
}

/**
 * Reads the legacy MySQL/MariaDB database (the platform's original engine) inside
 * `START TRANSACTION READ ONLY` on a session set to read-only: any write fails on the
 * server. Dates are returned as strings so no timezone conversion alters them.
 */
export class MysqlLegacySource implements LegacySource {
  readonly kind = 'mysql';
  private readonly pool: mysql.Pool;
  private readonly batchSize: number;

  constructor(private readonly options: MysqlLegacySourceOptions) {
    this.pool = mysql.createPool({
      uri: options.connectionString,
      connectionLimit: 2,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      charset: 'utf8mb4',
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
      const sql = buildMysqlSelect(m, { afterKey: cursor !== undefined, since });
      const connection = await this.pool.getConnection();
      let rows: Record<string, unknown>[];
      try {
        await connection.query('SET SESSION TRANSACTION READ ONLY');
        await connection.query('START TRANSACTION READ ONLY');
        const [result] = await connection.query(sql, params);
        rows = result as Record<string, unknown>[];
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
      for (const row of rows) yield projectRow(m, row);
      if (rows.length < this.batchSize) return;
      cursor = rows[rows.length - 1]?.[m.key];
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
