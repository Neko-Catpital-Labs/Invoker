import { defineConfig } from '@playwright/test';

const workers = Number(process.env.INVOKER_PLAYWRIGHT_WORKERS ?? (process.env.CI ? '1' : '2'));
const flakyTagPattern = /@flaky/;
const includeFlakyOnly = process.env.INVOKER_PLAYWRIGHT_FLAKY_ONLY === '1';
const excludeFlaky = process.env.INVOKER_PLAYWRIGHT_EXCLUDE_FLAKY === '1';

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  testDir: './e2e',
  timeout: 120000,
  retries: 0,
  workers: Number.isFinite(workers) && workers > 0 ? workers : 1,
  grep: includeFlakyOnly ? flakyTagPattern : undefined,
  grepInvert: !includeFlakyOnly && excludeFlaky ? flakyTagPattern : undefined,
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
