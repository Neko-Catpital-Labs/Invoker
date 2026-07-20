import { defineConfig } from '@playwright/test';

const workers = Number(process.env.INVOKER_PLAYWRIGHT_WORKERS ?? (process.env.CI ? '1' : '2'));

function regexpFromCliPattern(pattern: string): RegExp {
  const match = pattern.match(/^\/(.*)\/([gi]*)$/);
  return match ? new RegExp(match[1], match[2]) : new RegExp(pattern, 'gi');
}

function stripLocationSuffix(filePattern: string): string {
  return filePattern.replace(/:\d+(?::\d+)?$/, '');
}

function recoverPnpmForwardedTestFilters(argv: readonly string[]) {
  // pnpm appends args to scripts as `-- ...`; Playwright treats that separator
  // as the end of option parsing, so recover file and title filters here.
  const testCommandIndex = argv.indexOf('test');
  const separatorIndex = argv.indexOf('--', testCommandIndex === -1 ? 2 : testCommandIndex + 1);
  if (separatorIndex === -1) return {};

  const forwardedArgs = argv.slice(separatorIndex + 1);
  const testMatch: string[] = [];
  let grep: RegExp | undefined;
  let grepInvert: RegExp | undefined;

  for (let i = 0; i < forwardedArgs.length; i += 1) {
    const arg = forwardedArgs[i];
    if (arg === '-g' || arg === '--grep') {
      const pattern = forwardedArgs[i + 1];
      if (pattern) grep = regexpFromCliPattern(pattern);
      i += 1;
      continue;
    }
    if (arg.startsWith('--grep=')) {
      grep = regexpFromCliPattern(arg.slice('--grep='.length));
      continue;
    }
    if (arg === '--grep-invert') {
      const pattern = forwardedArgs[i + 1];
      if (pattern) grepInvert = regexpFromCliPattern(pattern);
      i += 1;
      continue;
    }
    if (arg.startsWith('--grep-invert=')) {
      grepInvert = regexpFromCliPattern(arg.slice('--grep-invert='.length));
      continue;
    }
    if (arg.startsWith('-')) continue;

    testMatch.push(stripLocationSuffix(arg));
  }

  return {
    ...(testMatch.length > 0 ? { testMatch } : {}),
    ...(grep ? { grep } : {}),
    ...(grepInvert ? { grepInvert } : {}),
  };
}

const forwardedTestFilters = recoverPnpmForwardedTestFilters(process.argv);

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  testDir: './e2e',
  ...forwardedTestFilters,
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
