import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@invoker/contracts';
import {
  CODERABBIT_ADDRESS_WORKER_KIND,
  PR_CONFLICT_REBASE_WORKER_KIND,
} from '@invoker/execution-engine';
import { runHeadless } from '../headless.js';
import type { HeadlessDeps } from '../headless.js';
import type { InvokerConfig } from '../config.js';

function buildWorkerDeps(invokerConfig: InvokerConfig): HeadlessDeps {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  // The headless `worker` command path reads only `logger` and `invokerConfig`,
  // and never invokes a persistence method when running a PR-maintenance kind,
  // so a minimal stand-in for the full owner deps is sufficient here.
  return { logger, invokerConfig } as unknown as HeadlessDeps;
}

/**
 * Drives the real headless worker entrypoint for one PR-maintenance kind and
 * asserts it constructed the worker and actually ran the shell entrypoint under
 * the threaded `prMaintenance` config. The dummy script writes a marker file
 * whose path arrives through the config `env` override, so a present marker
 * proves both the kind is runnable from the headless path and the config
 * threaded end-to-end.
 */
async function expectWorkerKindRunsEntrypoint(
  kind: string,
  scriptRelativePath: string,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'invoker-headless-prm-home-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'invoker-headless-prm-repo-'));
  const marker = join(repoRoot, 'entrypoint-ran.marker');
  const scriptPath = join(repoRoot, scriptRelativePath);
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(
    scriptPath,
    '#!/usr/bin/env bash\nset -e\nprintf \'ok\\n\' > "$INVOKER_PR_MAINTENANCE_MARKER"\n',
  );

  // Redirect the single-instance worker lock to a throwaway home so the scan
  // never touches the real Invoker home.
  const previousDbDir = process.env.INVOKER_DB_DIR;
  process.env.INVOKER_DB_DIR = home;
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  let entrypointRan = false;
  try {
    const deps = buildWorkerDeps({
      prMaintenance: {
        enabled: true,
        repoRoot,
        // Fresh lock path so the shared-lock probe reports "not held" and the
        // one-shot tick proceeds to spawn the entrypoint.
        lockPath: join(home, 'pr-maintenance.lock'),
        env: { INVOKER_PR_MAINTENANCE_MARKER: marker },
      },
    });
    await runHeadless(['worker', kind], deps);
    // Read the side effect before cleanup removes the temp trees below.
    entrypointRan = existsSync(marker);
  } finally {
    write.mockRestore();
    if (previousDbDir === undefined) delete process.env.INVOKER_DB_DIR;
    else process.env.INVOKER_DB_DIR = previousDbDir;
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }

  expect(entrypointRan).toBe(true);
}

describe('headless PR-maintenance workers', () => {
  it('exposes both PR-maintenance worker kinds from the headless worker registry', async () => {
    let stdout = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      stdout += chunk.toString();
      return true;
    });

    try {
      await runHeadless(['worker', 'list'], buildWorkerDeps({}));
    } finally {
      write.mockRestore();
    }

    expect(stdout).toContain(CODERABBIT_ADDRESS_WORKER_KIND);
    expect(stdout).toContain(PR_CONFLICT_REBASE_WORKER_KIND);
  });

  it('runs the coderabbit-address worker one-shot with the threaded prMaintenance config', async () => {
    await expectWorkerKindRunsEntrypoint(
      CODERABBIT_ADDRESS_WORKER_KIND,
      'scripts/cron-coderabbit-address.sh',
    );
  });

  it('runs the pr-conflict-rebase worker one-shot with the threaded prMaintenance config', async () => {
    await expectWorkerKindRunsEntrypoint(
      PR_CONFLICT_REBASE_WORKER_KIND,
      'scripts/cron-pr-conflict-rebase.sh',
    );
  });
});
