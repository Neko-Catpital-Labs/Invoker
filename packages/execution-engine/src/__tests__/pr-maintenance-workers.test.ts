import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CODERABBIT_ADDRESS_WORKER_KIND,
  DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS,
  PR_CONFLICT_REBASE_WORKER_KIND,
  createCoderabbitAddressWorker,
  createPrMaintenanceTick,
  runPrMaintenanceScript,
} from '../workers/pr-maintenance-workers.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
};

function makeRepoRoot(): string {
  const repoRoot = join(tmpdir(), `invoker-pr-maintenance-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
  return repoRoot;
}

describe('PR maintenance workers', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('polls shell maintenance workers on the five-minute default interval', async () => {
    vi.useFakeTimers();
    const onTick = vi.fn().mockResolvedValue(undefined);
    const worker = createCoderabbitAddressWorker({
      logger,
      installSignalHandlers: false,
      onTick,
    });

    worker.start();
    expect(worker.identity.kind).toBe(CODERABBIT_ADDRESS_WORKER_KIND);
    expect(onTick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS);

    expect(onTick).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it('passes repo-root and environment overrides to the shell entrypoint and logs child streams', async () => {
    const repoRoot = makeRepoRoot();
    const realRepoRoot = realpathSync(repoRoot);
    try {
      writeFileSync(join(repoRoot, 'scripts', 'cron-coderabbit-address.sh'), [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'printf "cwd=%s\\n" "$PWD"',
        'printf "dry=%s\\n" "$INVOKER_PR_CRON_DRY_RUN"',
        'printf "stderr-line\\n" >&2',
      ].join('\n'));

      await runPrMaintenanceScript({
        kind: CODERABBIT_ADDRESS_WORKER_KIND,
        repoRoot,
        scriptPath: 'scripts/cron-coderabbit-address.sh',
        shell: 'bash',
        env: { INVOKER_PR_CRON_DRY_RUN: '1' },
        logger,
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining(`stdout cwd=${realRepoRoot}`),
        expect.objectContaining({ kind: CODERABBIT_ADDRESS_WORKER_KIND, stream: 'stdout' }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('stdout dry=1'),
        expect.objectContaining({ kind: CODERABBIT_ADDRESS_WORKER_KIND, stream: 'stdout' }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('stderr stderr-line'),
        expect.objectContaining({ kind: CODERABBIT_ADDRESS_WORKER_KIND, stream: 'stderr' }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('PR maintenance script completed'),
        expect.objectContaining({ kind: CODERABBIT_ADDRESS_WORKER_KIND, code: 0 }),
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('treats a shared cron lock hit as a clean skip because the shell script remains authoritative', async () => {
    const repoRoot = makeRepoRoot();
    const lockBase = join(repoRoot, 'pr-crons.lock');
    mkdirSync(`${lockBase}.d`);
    try {
      writeFileSync(join(repoRoot, 'scripts', 'cron-pr-conflict-rebase.sh'), [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'lockdir="${INVOKER_PR_CRON_LOCK}.d"',
        'if ! mkdir "$lockdir" 2>/dev/null; then',
        '  echo "another PR cron operation in progress; exiting"',
        '  exit 0',
        'fi',
        'trap "rm -rf \\"$lockdir\\"" EXIT',
        'echo "ran unexpectedly"',
        'exit 2',
      ].join('\n'));

      await runPrMaintenanceScript({
        kind: PR_CONFLICT_REBASE_WORKER_KIND,
        repoRoot,
        scriptPath: 'scripts/cron-pr-conflict-rebase.sh',
        shell: 'bash',
        env: { INVOKER_PR_CRON_LOCK: lockBase },
        logger,
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('stdout another PR cron operation in progress; exiting'),
        expect.objectContaining({ kind: PR_CONFLICT_REBASE_WORKER_KIND, stream: 'stdout' }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('PR maintenance script completed'),
        expect.objectContaining({ kind: PR_CONFLICT_REBASE_WORKER_KIND, code: 0 }),
      );
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('builds a tick that runs the configured PR maintenance script through the injected runner', async () => {
    const runScript = vi.fn().mockResolvedValue(undefined);
    const tick = createPrMaintenanceTick({
      kind: PR_CONFLICT_REBASE_WORKER_KIND,
      scriptPath: 'scripts/cron-pr-conflict-rebase.sh',
      repoRoot: '.',
      env: { INVOKER_PR_CRON_DRY_RUN: '1' },
      shell: 'bash',
      logger,
      runScript,
    });

    await tick({ identity: { kind: PR_CONFLICT_REBASE_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(runScript).toHaveBeenCalledWith(expect.objectContaining({
      kind: PR_CONFLICT_REBASE_WORKER_KIND,
      scriptPath: 'scripts/cron-pr-conflict-rebase.sh',
      env: { INVOKER_PR_CRON_DRY_RUN: '1' },
      shell: 'bash',
      logger,
    }));
  });
});
