import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'off',
  },
  // Every spec runs in both languages (engineering rule 12: Arabic first).
  projects: [
    { name: 'ar', use: { ...devices['Desktop Chrome'], locale: 'ar' } },
    { name: 'en', use: { ...devices['Desktop Chrome'], locale: 'en' } },
  ],
  webServer: {
    command: 'pnpm --filter @bahith/db exec tsx ../../apps/web/e2e/server.ts',
    url: `http://localhost:${PORT}/ar`,
    reuseExistingServer: false,
    timeout: 240_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
});
