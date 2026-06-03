#!/usr/bin/env bash
set -euo pipefail

# Reproduce: direct `Orchestrator.recreateWorkflow(upstreamWorkflowId)` resets
# the upstream workflow but does NOT cascade to downstream workflows that have
# an external dependency on it. The cross-workflow cascade only fires when the
# recreate is routed through `applyInvalidation` (which wires the
# `cascadeDownstream` dep). Direct callers bypass it — that is the bug under
# review here.
#
# Modes:
#   --expect-bug   downstream tasks remain in their pre-recreate
#                  (completed/running) state — current behavior on this branch.
#   --expect-fixed downstream tasks are all reset to pending — the future
#                  fixed expectation that any direct-orchestrator fix must
#                  satisfy.
#
# This repro stays inside `workflow-core`: it does NOT touch app, API,
# headless, IPC, or UI surfaces. Higher-layer integration is intentionally
# out of scope for the lowest-level domain primitive.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION="bug"
KEEP_TEMP=0
TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-90}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-recreate-workflow-misses-downstream.sh [--expect-bug|--expect-fixed] [--keep-temp]

Modes:
  --expect-bug    (default) downstream tasks remain unchanged after direct
                  Orchestrator.recreateWorkflow(upstream) — current behavior.
  --expect-fixed  downstream tasks all reset to pending after the direct
                  recreate — the future fixed expectation.

Options:
  --keep-temp     do not delete the temporary directory or temp test file.

Exit codes:
  0  observed behavior matches the chosen expectation
  1  observed behavior does not match the chosen expectation
  2  invalid arguments or setup failure
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-bug)   EXPECTATION="bug"; shift ;;
    --expect-fixed) EXPECTATION="fixed"; shift ;;
    --keep-temp)    KEEP_TEMP=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)
      echo "repro: unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

TESTS_DIR="$ROOT_DIR/packages/workflow-core/src/__tests__"
if [[ ! -d "$TESTS_DIR" ]]; then
  echo "repro: expected tests dir not found: $TESTS_DIR" >&2
  exit 2
fi
if [[ ! -f "$TESTS_DIR/helpers/cross-workflow-cascade-helpers.ts" ]]; then
  echo "repro: expected helpers not found: $TESTS_DIR/helpers/cross-workflow-cascade-helpers.ts" >&2
  exit 2
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-recreate-misses-downstream.XXXXXX")"
TEMP_TEST="$(mktemp "$TESTS_DIR/tmp-repro-recreate-workflow-misses-downstream.XXXXXX.test.ts")"
VITEST_LOG="$TMP_DIR/vitest.log"

cleanup() {
  rm -f "$TEMP_TEST" 2>/dev/null || true
  if [[ "$KEEP_TEMP" != "1" ]]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if ! command -v pnpm >/dev/null 2>&1; then
  echo "repro: missing required command: pnpm" >&2
  exit 2
fi
if ! command -v timeout >/dev/null 2>&1; then
  echo "repro: missing required command: timeout" >&2
  exit 2
fi

# Emit the temporary Vitest test. The test imports the shared
# cross-workflow-cascade helpers (which already set up an upstream workflow,
# a downstream workflow with an external dependency on it, and drive both to
# the canonical pre-recreate state), then calls `recreateWorkflow` DIRECTLY
# on the Orchestrator instance — bypassing `applyInvalidation`. That is the
# precise primitive whose downstream-cascade behavior we are asserting on.
cat > "$TEMP_TEST" <<'EOF'
import { describe, it, expect } from 'vitest';
import {
  InMemoryPersistence,
  makeOrchestrator,
  setupChain,
} from './helpers/cross-workflow-cascade-helpers.js';

// Expectation mode is injected by the shell wrapper as an env var so the
// same test file body covers both --expect-bug and --expect-fixed.
const mode = process.env.REPRO_EXPECTATION ?? 'bug';

describe('repro: direct Orchestrator.recreateWorkflow downstream cascade', () => {
  it(`downstream workflow tasks should be pending only when fixed (mode=${mode})`, () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = makeOrchestrator(persistence);
    const ctx = setupChain(orchestrator);

    // Pre-conditions established by setupChain — sanity-check so a future
    // helper change cannot silently invalidate the repro.
    expect(orchestrator.getTask(ctx.downstreamRootId)!.status).toBe('completed');
    expect(orchestrator.getTask(ctx.downstreamMidId)!.status).toBe('completed');
    expect(orchestrator.getTask(ctx.downstreamLastId)!.status).toBe('running');

    // The action under test: direct primitive on the orchestrator. NO
    // routing through `applyInvalidation`, NO explicit cascadeDownstream
    // call. This is the lowest-level workflow-recreate operation.
    orchestrator.recreateWorkflow(ctx.upstreamWfId);

    // The upstream task is reset to pending and then auto-started by
    // recreateWorkflow's dispatch step, so it appears `running` again.
    // The upstream merge gate is reset and stays pending because it is
    // blocked by the still-running upstream task. These are control
    // observations — the bug is about the downstream workflow.
    expect(orchestrator.getTask(ctx.upstreamMergeId)!.status).toBe('pending');

    const downstreamRoot = orchestrator.getTask(ctx.downstreamRootId)!.status;
    const downstreamMid = orchestrator.getTask(ctx.downstreamMidId)!.status;
    const downstreamLast = orchestrator.getTask(ctx.downstreamLastId)!.status;

    if (mode === 'bug') {
      // Bug behavior: direct recreate leaves downstream untouched. The
      // downstream tasks remain in their pre-recreate state.
      expect(downstreamRoot, 'downstreamRoot should remain completed under the bug').toBe('completed');
      expect(downstreamMid, 'downstreamMid should remain completed under the bug').toBe('completed');
      expect(downstreamLast, 'downstreamLast should remain running under the bug').toBe('running');
    } else {
      // Fixed expectation: every downstream task (including the
      // downstream merge gate) is reset to pending so the chain
      // re-runs once the upstream merge gate re-closes.
      expect(downstreamRoot, 'downstreamRoot should be pending after fix').toBe('pending');
      expect(downstreamMid, 'downstreamMid should be pending after fix').toBe('pending');
      expect(downstreamLast, 'downstreamLast should be pending after fix').toBe('pending');
      expect(
        orchestrator.getTask(ctx.downstreamMergeId)!.status,
        'downstreamMerge should be pending after fix',
      ).toBe('pending');
    }
  });
});
EOF

echo "==> repro: direct Orchestrator.recreateWorkflow downstream-cascade"
echo "expectation : $EXPECTATION"
echo "temp test   : $TEMP_TEST"
echo "tmp dir     : $TMP_DIR"

set +e
REPRO_EXPECTATION="$EXPECTATION" \
  timeout "$TIMEOUT_SECONDS" \
  pnpm --filter @invoker/workflow-core exec vitest run "$TEMP_TEST" \
  >"$VITEST_LOG" 2>&1
VITEST_STATUS=$?
set -e

if [[ "$VITEST_STATUS" -eq 0 ]]; then
  echo "==> repro: vitest assertions held for mode=$EXPECTATION"
  if [[ "$EXPECTATION" == "bug" ]]; then
    echo "result: confirmed bug — direct recreateWorkflow does not cascade to downstream"
  else
    echo "result: confirmed fix — direct recreateWorkflow now cascades to downstream"
  fi
  exit 0
fi

echo "==> repro: vitest assertions failed for mode=$EXPECTATION"
echo "---- vitest output ----"
cat "$VITEST_LOG" >&2 || true
echo "---- end vitest output ----"
if [[ "$EXPECTATION" == "bug" ]]; then
  echo "result: bug expectation NOT met — downstream may have been cascaded, or the helper drifted" >&2
else
  echo "result: fixed expectation NOT met — downstream tasks were not all reset to pending" >&2
fi
exit 1
