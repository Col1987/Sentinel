import { defineConfig, devices } from '@playwright/test';
import { defaultSite } from './src/config/sites';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  globalSetup: './src/config/global-setup',
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 4,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/playwright-html', open: 'never' }],
  ],
  use: {
    baseURL: defaultSite.baseUrl,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'smoke',
      testMatch: '**/smoke/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'functional',
      testMatch: '**/functional/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'regression',
      testMatch: '**/regression/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'audit',
      testMatch: '**/audits/**/*.spec.ts',
      grep: /@audit/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'security',
      testMatch: '**/security/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
