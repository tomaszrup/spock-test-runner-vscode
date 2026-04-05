import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './ui',
  timeout: 120_000,
  retries: 1,
  workers: 1, // VS Code E2E must run serially
  reporter: [
    ['list'],
    ['html', { outputFolder: '../playwright-report', open: 'never' }],
  ],
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});
