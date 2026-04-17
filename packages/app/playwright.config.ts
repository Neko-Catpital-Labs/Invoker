import { defineConfig } from '@playwright/test';

const workers = Number(process.env.INVOKER_PLAYWRIGHT_WORKERS ?? (process.env.CI ? '1' : '2'));

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  testDir: './e2e',
  timeout: 120000,
  retries: 0,
  workers: Number.isFinite(workers) && workers > 0 ? workers : 1,
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
  use: {
    trace: 'on-first-retry',
    video: process.env.CAPTURE_VIDEO ? 'on' : 'off',
    screenshot: 'only-on-failure',
  },
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      threshold: 0.2,
      animations: 'disabled',
    },
  },
});
