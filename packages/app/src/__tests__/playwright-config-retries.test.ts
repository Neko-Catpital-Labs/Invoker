import { afterEach, describe, expect, it, vi } from 'vitest';

type PlaywrightConfig = {
  retries: number;
};

const PREVIOUS_ENV = {
  ci: process.env.CI,
  retries: process.env.INVOKER_PLAYWRIGHT_RETRIES,
  browserRegistry: process.env.INVOKER_E2E_BROWSER_PROCESS_REGISTRY,
};

async function loadConfig(retries: string): Promise<PlaywrightConfig> {
  process.env.INVOKER_PLAYWRIGHT_RETRIES = retries;
  process.env.INVOKER_E2E_BROWSER_PROCESS_REGISTRY = '/tmp/invoker-playwright-config-retries-test.txt';
  vi.resetModules();
  // Exception: this test must re-evaluate the config module after changing env vars.
  return (await import('../../playwright.config.ts')).default as PlaywrightConfig;
}

describe('Playwright retry config', () => {
  afterEach(() => {
    if (PREVIOUS_ENV.ci === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = PREVIOUS_ENV.ci;
    }
    if (PREVIOUS_ENV.retries === undefined) {
      delete process.env.INVOKER_PLAYWRIGHT_RETRIES;
    } else {
      process.env.INVOKER_PLAYWRIGHT_RETRIES = PREVIOUS_ENV.retries;
    }
    if (PREVIOUS_ENV.browserRegistry === undefined) {
      delete process.env.INVOKER_E2E_BROWSER_PROCESS_REGISTRY;
    } else {
      process.env.INVOKER_E2E_BROWSER_PROCESS_REGISTRY = PREVIOUS_ENV.browserRegistry;
    }
  });

  it('keeps non-negative integer retry overrides', async () => {
    const config = await loadConfig('2');

    expect(config.retries).toBe(2);
  });

  it('rejects fractional retry overrides', async () => {
    const config = await loadConfig('1.5');

    expect(config.retries).toBe(0);
  });
});
