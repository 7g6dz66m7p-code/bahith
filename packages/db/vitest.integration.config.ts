import { defineConfig } from 'vitest/config';

// Integration tests run against a real Postgres 16 + pgvector started by Testcontainers.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
