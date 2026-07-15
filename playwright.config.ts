import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { defaultSite } from './src/config/sites';

loadEnv(); // populate process.env from .env before any test or config value is evaluated

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  globalSetup: './src/config/global-setup',
  retries: process.env.CI ? 2 : 0,
  // Parallel workers all log into the same real admin Firebase account in LIVE_MODE,
  // causing session/UI-state races (e.g. #btn-login intermittently failing to render) — force serial.
  workers: (process.env.CI || process.env.SENTINEL_LIVE_MODE === 'true') ? 1 : 4,
  reporter: [
    ['list'],
    ['./src/reports/sentinel-reporter.ts'],
    ['./src/reports/test-case-reporter.ts'],
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
    {
      name: 'admin',
      testMatch: '**/admin/**/*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
