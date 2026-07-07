#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #3247 (packages/app/src/worker-control.ts):
# disabledPolicyReasonForKind returned hardcoded literals instead of the
# actual policy inputs:
#   - autoFixRetries <= 0 always reported 'autoFixRetries=0', even when the
#     configured value is negative (e.g. -1).
#   - autoApproveAIFixes !== true always reported 'autoApproveAIFixes=false',
#     even when the key is unset (undefined) in config.
# The policyReason is surfaced through the worker status API and through the
# error thrown by controller.start(), so operators debugging via those
# surfaces see values that contradict their actual config.
#
# This repro builds a controller with autoFixRetries=-1 and an unset
# autoApproveAIFixes, then asserts the reported reasons reflect the real
# values ('autoFixRetries=-1', 'autoApproveAIFixes=unset').
#   - Buggy -> reasons say '=0' / '=false' -> vitest FAIL -> repro FAIL.
#   - Fixed -> reasons reflect actual values -> repro PASS.

REPO_ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
APP_DIR="$REPO_ROOT/packages/app"
VITEST="$APP_DIR/node_modules/.bin/vitest"

if [[ ! -x "$VITEST" ]]; then
  echo "[repro] FAIL: vitest not found at $VITEST; run 'pnpm install' at the repo root first."
  exit 1
fi

SLUG=".repro-coderabbit-pr3247-policy-reason-actual-values"
TEST_DIR="$APP_DIR/$SLUG"
TEST_FILE="$TEST_DIR/repro.test.ts"
mkdir -p "$TEST_DIR"
trap 'rm -rf "$TEST_DIR"' EXIT

cat > "$TEST_FILE" <<'TS'
import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_APPROVE_WORKER_KIND,
  AUTO_FIX_WORKER_KIND,
  CI_FAILURE_WORKER_KIND,
  createWorkerRegistry,
  type WorkerRuntime,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';

import { createWorkerRuntimeController } from '../src/worker-control.js';

function runtime(kind: string): WorkerRuntime {
  let running = false;
  return {
    identity: { kind, instanceId: `${kind}-instance` },
    start: vi.fn(() => { running = true; }),
    wake: vi.fn(),
    tick: vi.fn(async () => {}),
    stop: vi.fn(async () => { running = false; }),
    isRunning: vi.fn(() => running),
  };
}

function makeController(options: { autoFixRetries?: number; autoApproveAIFixes?: boolean }) {
  const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
  for (const kind of [AUTO_FIX_WORKER_KIND, AUTO_APPROVE_WORKER_KIND, CI_FAILURE_WORKER_KIND]) {
    registry.register({ kind, note: `${kind} test worker`, factory: () => runtime(kind) });
  }
  return createWorkerRuntimeController({
    registry,
    deps: {
      store: {} as WorkerRuntimeDependencies['store'],
      submitter: { submit: vi.fn(() => 1) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as WorkerRuntimeDependencies,
    autoStartKinds: [],
    persistence: {
      listWorkerActions: vi.fn(() => []),
      listWorkflows: vi.fn(() => []),
      loadTasks: vi.fn(() => []),
      getEvents: vi.fn(() => []),
    } as never,
    autoFixRetries: options.autoFixRetries,
    autoApproveAIFixes: options.autoApproveAIFixes,
    canControl: () => true,
  });
}

describe('CodeRabbit PR #3247: policyReason reflects actual config values', () => {
  it('reports the real negative autoFixRetries value, not the literal 0', () => {
    const controller = makeController({ autoFixRetries: -1, autoApproveAIFixes: true });

    expect(() => controller.start(AUTO_FIX_WORKER_KIND)).toThrow('autoFixRetries=-1');
    expect(() => controller.start(CI_FAILURE_WORKER_KIND)).toThrow('autoFixRetries=-1');

    const snapshot = controller.snapshot();
    expect(snapshot.workers.find((worker) => worker.kind === AUTO_FIX_WORKER_KIND)?.policyReason)
      .toBe('autoFixRetries=-1');
    expect(snapshot.workers.find((worker) => worker.kind === CI_FAILURE_WORKER_KIND)?.policyReason)
      .toBe('autoFixRetries=-1');
  });

  it('reports an unset autoApproveAIFixes as unset, not false', () => {
    const controller = makeController({ autoFixRetries: 3 });

    expect(() => controller.start(AUTO_APPROVE_WORKER_KIND)).toThrow('autoApproveAIFixes=unset');

    const snapshot = controller.snapshot();
    expect(snapshot.workers.find((worker) => worker.kind === AUTO_APPROVE_WORKER_KIND)?.policyReason)
      .toBe('autoApproveAIFixes=unset');
  });

  it('still reports explicit values verbatim', () => {
    const zeroRetries = makeController({ autoFixRetries: 0, autoApproveAIFixes: false });

    const snapshot = zeroRetries.snapshot();
    expect(snapshot.workers.find((worker) => worker.kind === AUTO_FIX_WORKER_KIND)?.policyReason)
      .toBe('autoFixRetries=0');
    expect(snapshot.workers.find((worker) => worker.kind === AUTO_APPROVE_WORKER_KIND)?.policyReason)
      .toBe('autoApproveAIFixes=false');
  });
});
TS

set +e
( cd "$APP_DIR" && "$VITEST" run --reporter=dot "$SLUG/repro.test.ts" )
CODE=$?
set -e

if [[ "$CODE" -ne 0 ]]; then
  echo "[repro] FAIL: disabledPolicyReasonForKind reports hardcoded 'autoFixRetries=0' / 'autoApproveAIFixes=false' instead of the actual config values."
  exit 1
fi

echo "[repro] PASS: worker policyReason reflects the actual autoFixRetries and autoApproveAIFixes values."
exit 0
