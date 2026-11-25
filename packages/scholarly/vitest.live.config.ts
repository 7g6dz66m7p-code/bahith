import { defineConfig } from 'vitest/config';

/**
 * Live tests hit the real scholarly APIs once per provider. They run only when
 * SCHOLARLY_LIVE=1 (see test/live) and are never part of `pnpm test` or CI.
 */
export default defineConfig({
  test: {
    include: ['test/live/**/*.live.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
