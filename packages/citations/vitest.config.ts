import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Building a citeproc engine for a CSL style takes about a second the first time.
    testTimeout: 30_000,
  },
});
