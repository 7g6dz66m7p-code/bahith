import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
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
    command: `pnpm exec next build && pnpm exec next start --port ${PORT}`,
    url: `http://localhost:${PORT}/ar`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
