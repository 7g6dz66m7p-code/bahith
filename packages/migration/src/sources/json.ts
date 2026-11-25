import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { Entity } from '../canonical';
import { ENTITIES } from '../canonical';
import type { Mapping, RawRecord } from '../mapping';
import { projectRow, toDate } from '../mapping';
import type { LegacySource, ReadOptions } from '../source';

const dumpSchema = z.record(z.string(), z.array(z.record(z.string(), z.unknown())));
export type LegacyDump = z.infer<typeof dumpSchema>;

/**
 * Reads an exported dump shaped `{ "<legacy table>": [ { "<legacy column>": value } ] }`.
 * The same mapping file as the Postgres reader applies; a qualified table name
 * (`public.members`) also matches a dump key without the schema (`members`).
 */
export class JsonDumpSource implements LegacySource {
  readonly kind = 'json';

  constructor(
    private readonly dump: LegacyDump,
    private readonly mapping: Mapping,
  ) {}

  static async fromFile(path: string, mapping: Mapping): Promise<JsonDumpSource> {
    const parsed = dumpSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    return new JsonDumpSource(parsed, mapping);
  }

  entities(): readonly Entity[] {
    return ENTITIES.filter((e) => this.mapping.entities[e] !== undefined);
  }

  async *read(entity: Entity, options: ReadOptions = {}): AsyncIterable<RawRecord> {
    const m = this.mapping.entities[entity];
    if (m === undefined) return;
    const bare = m.table.includes('.') ? m.table.slice(m.table.indexOf('.') + 1) : m.table;
    const rows = this.dump[m.table] ?? this.dump[bare] ?? [];
    for (const row of rows) {
      const projected = projectRow(m, row);
      if (options.since !== undefined) {
        const updated = toDate(projected['updatedAt']);
        if (updated !== null && updated.getTime() < options.since.getTime()) continue;
      }
      yield projected;
    }
    await Promise.resolve();
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
