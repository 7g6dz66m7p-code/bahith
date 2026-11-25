import { defineConfig } from 'vitest/config';

// Real MinIO and Redis containers (Testcontainers).
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
