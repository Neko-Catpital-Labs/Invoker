#!/usr/bin/env bash
# CodeRabbit PR #3584: replacing an SSH executor for the same target must destroy
# the stale instance before dropping it from TaskRunner.sshExecutorCache.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="$REPO_ROOT/packages/execution-engine/src/__tests__/coderabbit-pr3584-stale-ssh-executor-destroy-repro.test.ts"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr3584-stale-ssh.XXXXXX.log")"
cleanup() {
  rm -f "$TARGET" "$LOG_FILE"
}
trap cleanup EXIT

cat > "$TARGET" <<'TS'
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import { TaskRunner } from '../task-runner.js';
import { SshExecutor } from '../ssh-executor.js';

function makeTask(id: string): TaskState {
  return {
    id,
    description: 'SSH stale executor repro',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { runnerKind: 'ssh', poolMemberId: 'remote-a' },
    execution: {},
  } as TaskState;
}

describe('CodeRabbit PR #3584 stale SSH executor cleanup repro', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('destroys the stale SSH executor when a target fingerprint changes', () => {
    const destroyAll = vi.spyOn(SshExecutor.prototype, 'destroyAll').mockResolvedValue(undefined);
    const provider = vi.fn()
      .mockReturnValueOnce({
        'remote-a': { host: 'dev.example.com', user: 'deployer', sshKeyPath: '/old/key' },
      })
      .mockReturnValueOnce({
        'remote-a': { host: 'dev.example.com', user: 'deployer', sshKeyPath: '/new/key' },
      });

    const runner = new TaskRunner({
      orchestrator: { getTask: () => undefined } as any,
      persistence: {} as any,
      executorRegistry: {
        getDefault: () => ({ type: 'worktree' }),
        get: () => undefined,
        getAll: () => [],
        register: vi.fn(),
      } as any,
      cwd: '/tmp',
      remoteTargetsProvider: provider,
    });

    const first = runner.selectExecutor(makeTask('first'));
    runner.selectExecutor(makeTask('second'));

    expect(destroyAll).toHaveBeenCalledTimes(1);
    expect(destroyAll.mock.contexts[0]).toBe(first.executor);
  });
});
TS

echo "[repro] PR #3584: stale SSH executors must be destroyed when target config changes."
if pnpm -C "$REPO_ROOT" --filter @invoker/execution-engine exec vitest run \
  src/__tests__/coderabbit-pr3584-stale-ssh-executor-destroy-repro.test.ts \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: stale SSH executor destroyAll() is called before cache replacement."
  exit 0
else
  status=$?
  echo "[repro] FAIL: stale SSH executor was evicted without destroyAll(); live SSH processes can leak." >&2
  cat "$LOG_FILE" >&2
  exit "$status"
fi
