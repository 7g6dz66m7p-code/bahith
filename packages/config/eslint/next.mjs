import nextVitals from 'eslint-config-next/core-web-vitals';

import { baseConfig } from './base.mjs';

/**
 * ESLint flat config for the Next.js app: the shared base plus Next.js rules.
 *
 * @param {{ tsconfigRootDir: string }} options
 */
export function nextConfig({ tsconfigRootDir }) {
  return [
    ...nextVitals,
    ...baseConfig({ tsconfigRootDir }),
    {
      languageOptions: {
        globals: {},
      },
      rules: {
        // Arabic-first (engineering rule 12): no hard-coded text inside components.
        'react/jsx-no-literals': ['error', { noStrings: true, ignoreProps: true }],
      },
    },
    {
      ignores: ['next-env.d.ts'],
    },
  ];
}
