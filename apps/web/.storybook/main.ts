import type { StorybookConfig } from '@storybook/nextjs-vite';

/**
 * Storybook for BAHITH's real UI: the Liquid Glass engine (@bahith/ui) and the dashboard
 * panels, rendered with the app's own CSS, translations and Next.js routing (mocked by
 * the framework). Stories use clearly marked fixtures, never production data.
 */
const config: StorybookConfig = {
  stories: ['../src/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y'],
  framework: { name: '@storybook/nextjs-vite', options: {} },
  core: { disableTelemetry: true },
};

export default config;
