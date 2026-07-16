import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { defineConfig } from '@playwright/test';
import { E2E_BROWSER_REGISTRY_ENV } from './e2e/fixtures/browser-process-registry.js';

const workers = Number(process.env.INVOKER_PLAYWRIGHT_WORKERS ?? (process.env.CI ? '1' : '2'));
const retries = Number(process.env.INVOKER_PLAYWRIGHT_RETRIES ?? (process.env.CI ? '2' : '0'));
process.env[E2E_BROWSER_REGISTRY_ENV] ??= path.join(
  mkdtempSync(path.join(tmpdir(), 'invoker-e2e-browser-registry-')),
  'user-data-dirs.txt',
);

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  testDir: './e2e',
  timeout: 120000,
  retries: Number.isFinite(retries) && retries >= 0 ? retries : 0,
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
