import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

import * as schema from '../src/schema/index';

/** Every table declared in the Drizzle schema. */
export const allTables: PgTable[] = Object.values<unknown>(schema).filter(
  (value): value is PgTable => is(value, PgTable),
);
