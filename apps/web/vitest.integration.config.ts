import path from 'node:path';

import { defineConfig } from 'vitest/config';

// Integration tests run against real Postgres and Redis containers (Testcontainers).
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
