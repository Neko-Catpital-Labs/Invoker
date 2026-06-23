import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const maxWorkers = process.env.INVOKER_VITEST_MAX_WORKERS
  ?? (process.env.INVOKER_VITEST_HIGH_RESOURCE === '1' ? undefined : 2);
const require = createRequire(import.meta.url);

function loadReporters() {
  const reporters = ['default'];

  try {
    const { default: MergifyReporter } = require(`${process.cwd()}/node_modules/@mergifyio/vitest`);
    reporters.push(new MergifyReporter());
  } catch {
    // Keep workspace tests runnable even when package-level config resolution
    // cannot see the reporter package from a nested package directory.
  }

  return reporters;
}

export default defineConfig({
  test: {
    exclude: ['**/dist/**'],
    globals: true,
    // App plan-parser tests call git ls-remote (execSync timeout 10s); Vitest default 5s flakes.
    testTimeout: 20_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        ...(maxWorkers ? { maxForks: Number(maxWorkers) || maxWorkers } : {}),
        maxMemoryLimitBeforeRecycle: 512 * 1024 * 1024, // 512MB — restart fork to shed leaked memory
      },
    },
    reporters: loadReporters(),
  },
});
