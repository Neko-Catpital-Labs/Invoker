import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  CODERABBIT_ADDRESS_WORKER_KIND,
  PR_CI_FAILURE_SCAN_WORKER_KIND,
  PR_ADMIN_BYPASS_LAND_WORKER_KIND,
  PR_CONFLICT_REBASE_WORKER_KIND,
} from '@invoker/execution-engine';
import { runHeadless } from '../headless.js';

/**
 * Write a throwaway cron entrypoint that records proof the worker ran with the
 * threaded config: it copies the injected `INVOKER_PR_TEST_TOKEN` env override
 * into a marker under the threaded `INVOKER_REPO_ROOT`. Reading the marker back
 * proves both the repoRoot and env launch fields reached the shell tick.
 */
function writeCronScript(repoRoot: string, scriptRelativePath: string, markerName: string): void {
  const scriptPath = join(repoRoot, scriptRelativePath);
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash\nset -eu\nprintf '%s' "$INVOKER_PR_TEST_TOKEN" > "$INVOKER_REPO_ROOT/${markerName}"\n`,
    { mode: 0o755 },
  );
}

/** Minimal headless deps for a one-shot PR-maintenance worker run. */
function makeWorkerDeps(repoRoot: string, token: string): unknown {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() },
    // The PR-maintenance tick never touches the store/submitter; provide a stub
    // so the shared factory-deps construction has something to reference.
    persistence: { enqueueWorkflowMutationIntent: vi.fn(() => 1) },
    invokerConfig: {
      prMaintenance: {
        enabled: true,
        repoRoot,
        lockPath: join(repoRoot, 'pr-crons.lock'),
        env: { INVOKER_PR_TEST_TOKEN: token },
      },
    },
  };
}

describe('headless worker PR-maintenance', () => {
  let repoRoot: string;
  let homeRoot: string;
  let previousDbDir: string | undefined;
  let write: MockInstance;
  let stdout: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'invoker-headless-pr-maintenance-repo-'));
    homeRoot = mkdtempSync(join(tmpdir(), 'invoker-headless-pr-maintenance-home-'));
    // Point the cross-process worker lock at a throwaway home so a one-shot scan
    // never contends with the real Invoker home.
    previousDbDir = process.env.INVOKER_DB_DIR;
    process.env.INVOKER_DB_DIR = homeRoot;
    stdout = '';
    write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    write.mockRestore();
    if (previousDbDir === undefined) delete process.env.INVOKER_DB_DIR;
    else process.env.INVOKER_DB_DIR = previousDbDir;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
  });

  it('rejects the retired coderabbit-address worker', async () => {
    writeCronScript(repoRoot, 'scripts/cron-coderabbit-address.sh', 'coderabbit.marker');

    await expect(runHeadless(['worker', CODERABBIT_ADDRESS_WORKER_KIND], makeWorkerDeps(repoRoot, 'cr-token') as never))
      .rejects.toThrow('Unknown worker kind');
  });

  it('rejects the retired pr-conflict-rebase worker', async () => {
    writeCronScript(repoRoot, 'scripts/cron-pr-conflict-rebase.sh', 'rebase.marker');

    await expect(runHeadless(['worker', PR_CONFLICT_REBASE_WORKER_KIND], makeWorkerDeps(repoRoot, 'rebase-token') as never))
      .rejects.toThrow('Unknown worker kind');
  });
  it('rejects the retired pr-ci-failure-scan worker', async () => {
    writeCronScript(repoRoot, 'packages/execution-engine/scripts/cron-pr-ci-failure.sh', 'pr-ci.marker');

    await expect(runHeadless(['worker', PR_CI_FAILURE_SCAN_WORKER_KIND], makeWorkerDeps(repoRoot, 'scan-token') as never))
      .rejects.toThrow('Unknown worker kind');
  });

  it('runs the pr-admin-bypass-land worker when PR maintenance is enabled', async () => {
    writeCronScript(repoRoot, 'scripts/cron-pr-admin-bypass-land.sh', 'land.marker');

    await expect(runHeadless(['worker', PR_ADMIN_BYPASS_LAND_WORKER_KIND], makeWorkerDeps(repoRoot, 'land-token') as never))
      .resolves.toBeUndefined();
  });
  
  it('threads repoRoot and env into the pr-admin-bypass worker shell tick', async () => {
    writeCronScript(repoRoot, 'scripts/cron-pr-admin-bypass-land.sh', 'land.marker');

    await runHeadless(['worker', PR_ADMIN_BYPASS_LAND_WORKER_KIND], makeWorkerDeps(repoRoot, 'land-token') as never);

    expect(stdout).toContain(`${PR_ADMIN_BYPASS_LAND_WORKER_KIND} worker scan completed.`);
    expect(readFileSync(join(repoRoot, 'land.marker'), 'utf8')).toBe('land-token');
  });


  it('lists the active admin-bypass worker but not the other retired PR-maintenance kinds', async () => {
    await runHeadless(['worker', 'list'], { invokerConfig: {} } as never);

    expect(stdout).toContain('Worker kinds');
    expect(stdout).not.toContain(CODERABBIT_ADDRESS_WORKER_KIND);
    expect(stdout).not.toContain(PR_CONFLICT_REBASE_WORKER_KIND);
    expect(stdout).not.toContain(PR_CI_FAILURE_SCAN_WORKER_KIND);
    expect(stdout).toContain(PR_ADMIN_BYPASS_LAND_WORKER_KIND);
  });
});
