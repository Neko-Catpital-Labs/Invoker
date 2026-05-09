#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION=""
KEEP_ARTIFACTS=0
TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-180}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-fix-intent-cancellation-and-stale-ssh-metadata.sh --expect bug|fixed [--keep-artifacts]

What it proves:
  1. A running `invoker:fix-with-agent` workflow mutation can be invalidated by
     `invoker:recreate-task`, yet the underlying async fix side effect still runs afterward.
  2. A stale SSH executor startup failure can write old `workspacePath` / `branch`
     metadata back onto the task row even after `selectedAttemptId` has moved to a
     fresh attempt.
  3. The existing SSH worktree collision proof still reproduces the
     `already used by worktree at ...` git failure signature.

Exit codes:
  0  observed behavior matches --expect
  1  observed behavior does not match --expect
  2  repro setup or assertion was invalid / unexpected
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    --keep-artifacts)
      KEEP_ARTIFACTS=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "repro: unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "bug" && "$EXPECTATION" != "fixed" ]]; then
  echo "repro: --expect requires bug|fixed" >&2
  usage >&2
  exit 2
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "repro: missing required command: $1" >&2
    exit 2
  }
}

require_cmd pnpm
require_cmd timeout
require_cmd git

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-fix-intent.XXXXXX")"
HELPER_TEST="$(mktemp "$ROOT_DIR/packages/app/src/__tests__/tmp-repro-fix-intent.XXXXXX.test.ts")"
HELPER_LOG="$TMP_DIR/helper-vitest.log"
SSH_REPRO_LOG="$TMP_DIR/ssh-worktree-vitest.log"
PROOF_FIX_INTENT="$TMP_DIR/proof-fix-intent.json"
PROOF_STALE_METADATA="$TMP_DIR/proof-stale-startup-metadata.json"

cleanup() {
  rm -f "$HELPER_TEST" 2>/dev/null || true
  if [[ "$KEEP_ARTIFACTS" != "1" ]]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cat > "$HELPER_TEST" <<EOF
import { describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { SQLiteAdapter } from '${ROOT_DIR}/packages/data-store/src/sqlite-adapter.ts';
import { PersistedWorkflowMutationCoordinator } from '${ROOT_DIR}/packages/app/src/persisted-workflow-mutation-coordinator.ts';
import { TaskRunner } from '${ROOT_DIR}/packages/execution-engine/src/task-runner.ts';

async function waitFor(check: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    await delay(10);
  }
  throw new Error(\`Timed out waiting for \${label}\`);
}

describe('fix intent invalidation + stale startup metadata repro', () => {
  it('proves invalidating a running fix intent does not cancel the underlying side effect', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const order: string[] = [];
    let recreateResolvedAt = 0;
    let sideEffectAt = 0;

    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (channel, args) => {
        if (channel === 'invoker:fix-with-agent') {
          order.push('fix:start');
          await delay(120);
          sideEffectAt = Date.now();
          order.push('fix:side-effect');
          writeFileSync('${PROOF_FIX_INTENT}', JSON.stringify({
            order,
            recreateResolvedAt,
            sideEffectAt,
            args,
          }, null, 2));
          return;
        }
        if (channel === 'invoker:recreate-task') {
          order.push('recreate');
          recreateResolvedAt = Date.now();
          return;
        }
      },
    );

    const olderRunning = coordinator.enqueue<void>(
      'wf-1',
      'normal',
      'invoker:fix-with-agent',
      ['wf-1/blocker-task', 'claude'],
    );
    await waitFor(
      () => adapter.listWorkflowMutationIntents('wf-1', ['running']).length === 1,
      'running fix intent',
    );

    const recreateTask = coordinator.enqueue<void>(
      'wf-1',
      'high',
      'invoker:recreate-task',
      ['wf-1/target-task'],
    );
    await recreateTask;
    await expect(olderRunning).rejects.toThrow(/superseded by recreate intent/i);

    await waitFor(
      () => existsSync('${PROOF_FIX_INTENT}'),
      'post-invalidation fix side effect',
    );

    const intents = adapter.listWorkflowMutationIntents('wf-1');
    expect(intents.find((intent) => intent.id === 1)?.status).toBe('failed');
    expect(intents.find((intent) => intent.id === 2)?.status).toBe('completed');
    expect(order).toEqual(['fix:start', 'recreate', 'fix:side-effect']);
    expect(sideEffectAt).toBeGreaterThan(recreateResolvedAt);
  });

  it('proves stale SSH startup-failure metadata is written back after selectedAttemptId moves forward', async () => {
    const ownerPath = '/home/invoker/.invoker/worktrees/f19efd3eabc6/experiment-wf-1-task-old-attempt';
    const oldBranch = 'experiment/wf-1/task/old-attempt';

    const task: any = {
      id: 'wf-1/task',
      description: 'repro task',
      status: 'running',
      dependencies: [],
      createdAt: new Date(),
      config: {
        command: 'pnpm test',
        executorType: 'ssh',
      },
      execution: {
        generation: 7,
        selectedAttemptId: 'attempt-1',
      },
    };

    let rejectStart: ((error: unknown) => void) | undefined;
    const updateCalls: Array<{ id: string; changes: any }> = [];
    const responses: any[] = [];

    const failingExecutor = {
      type: 'ssh',
      start: vi.fn().mockImplementation(() => new Promise((_resolve, reject) => {
        rejectStart = reject;
      })),
      onComplete: vi.fn(),
      onOutput: vi.fn(),
      onHeartbeat: vi.fn(),
      kill: vi.fn(),
      destroyAll: vi.fn(),
    };

    const runner = new TaskRunner({
      orchestrator: {
        getTask: () => task,
        getAllTasks: () => [task],
        handleWorkerResponse: (response: any) => {
          responses.push(response);
          return [];
        },
      } as any,
      persistence: {
        updateTask: (id: string, changes: any) => {
          updateCalls.push({ id, changes });
        },
        appendTaskOutput: vi.fn(),
        updateAttempt: vi.fn(),
      } as any,
      executorRegistry: {
        getDefault: () => failingExecutor,
        get: (type: string) => type === 'ssh' ? failingExecutor : undefined,
        getAll: () => [failingExecutor],
        register: vi.fn(),
      } as any,
      cwd: '/tmp',
    });

    const executePromise = runner.executeTask(task);
    await waitFor(() => typeof rejectStart === 'function', 'executor.start invocation');

    task.execution.selectedAttemptId = 'attempt-2';
    task.status = 'pending';

    rejectStart!(Object.assign(
      new Error(
        "SSH remote script failed (exit=128)\\n" +
          "STDERR:\\n" +
          "fatal: 'experiment/wf-1/task/old-attempt' is already used by worktree at '" + ownerPath + "'\\n",
      ),
      {
        workspacePath: ownerPath,
        branch: oldBranch,
      },
    ));

    await executePromise;

    const staleMetadataWrite = updateCalls.find((call) =>
      call.id === 'wf-1/task'
      && call.changes?.execution?.workspacePath === ownerPath
      && call.changes?.execution?.branch === oldBranch,
    );

    writeFileSync('${PROOF_STALE_METADATA}', JSON.stringify({
      selectedAttemptIdAfterRecreate: task.execution.selectedAttemptId,
      taskStatusAfterRecreate: task.status,
      staleMetadataWrite,
      failureResponse: responses[0],
    }, null, 2));

    expect(task.execution.selectedAttemptId).toBe('attempt-2');
    expect(staleMetadataWrite).toBeTruthy();
    expect(responses[0]?.attemptId).toBe('attempt-1');
  });
});
EOF

cd "$ROOT_DIR"

echo "==> repro: helper proof (intent invalidation + stale startup metadata)"
set +e
timeout "$TIMEOUT_SECONDS" \
  pnpm --filter @invoker/app exec vitest run "$HELPER_TEST" \
  >"$HELPER_LOG" 2>&1
HELPER_STATUS=$?
set -e

if [[ "$HELPER_STATUS" -ne 0 ]]; then
  OBSERVED="fixed"
else
  OBSERVED="bug"
fi

echo "helper_observed : $OBSERVED"
echo "expected        : $EXPECTATION"

echo "==> repro: existing SSH worktree collision proof"
set +e
timeout "$TIMEOUT_SECONDS" \
  pnpm --filter @invoker/execution-engine exec vitest run src/__tests__/ssh-worktree-metadata-repro.test.ts \
  >"$SSH_REPRO_LOG" 2>&1
SSH_REPRO_STATUS=$?
set -e

if [[ "$SSH_REPRO_STATUS" -ne 0 ]]; then
  echo "repro: existing ssh-worktree-metadata-repro test failed unexpectedly" >&2
  cat "$SSH_REPRO_LOG" >&2 || true
  exit 2
fi

echo "==> repro summary"
echo "artifacts         : $TMP_DIR"
echo "helper_vitest_log : $HELPER_LOG"
echo "ssh_vitest_log    : $SSH_REPRO_LOG"
echo "proof_fix_intent  : $PROOF_FIX_INTENT"
echo "proof_stale_meta  : $PROOF_STALE_METADATA"

if [[ -f "$PROOF_FIX_INTENT" ]]; then
  echo
  echo "-- proof: invalidated fix side effect --"
  cat "$PROOF_FIX_INTENT"
fi

if [[ -f "$PROOF_STALE_METADATA" ]]; then
  echo
  echo "-- proof: stale startup metadata write --"
  cat "$PROOF_STALE_METADATA"
fi

if [[ "$OBSERVED" != "$EXPECTATION" ]]; then
  echo
  echo "==> repro mismatch"
  cat "$HELPER_LOG" >&2 || true
  exit 1
fi

echo
echo "==> repro matched expectation"
exit 0
