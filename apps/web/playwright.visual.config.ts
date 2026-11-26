import { defineConfig, devices } from '@playwright/test';

const PORT = 6106;

/**
 * Visual regression and accessibility of the Storybook stories (pnpm build-storybook
 * first). Deterministic: fixtures, fonts bundled with the app, animations disabled.
 */
export default defineConfig({
  testDir: './visual',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  use: { baseURL: `http://127.0.0.1:${String(PORT)}`, trace: 'off' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: {
    command: `python3 -m http.server ${String(PORT)} --bind 127.0.0.1 --directory storybook-static`,
    url: `http://127.0.0.1:${String(PORT)}/index.json`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
