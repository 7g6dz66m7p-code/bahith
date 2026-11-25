import { defineConfig } from 'drizzle-kit';

// Used only by `drizzle-kit generate` / `drizzle-kit check`, which diff the schema
// against the snapshots in ./migrations and never connect to a database.
// Applying migrations goes through src/migrator.ts (up + tested down).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  strict: true,
});
