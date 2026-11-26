import { nextConfig } from '@bahith/config/eslint/next';

const config = [
  // Build output of Storybook and Lighthouse CI, and visual baselines.
  { ignores: ['storybook-static/**', '.lighthouseci/**', 'visual/__screenshots__/**'] },
  ...nextConfig({ tsconfigRootDir: import.meta.dirname }),
];

export default config;
