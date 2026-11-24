import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    include: ['test/unit/**/*.test.ts'],
    // next-intl's Next subpath imports need the same resolver as application code.
    server: { deps: { inline: ['next-intl'] } },
  },
});
