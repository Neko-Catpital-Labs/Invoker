#!/usr/bin/env bash
set -euo pipefail

# Bug-only repro for workflow/task graph status divergence.
#
# The renderer bug: workflow labels can continue reading stale WorkflowMeta
# status while the selected task mini-DAG has already updated from TaskState
# deltas. This entrypoint succeeds only while the focused divergence proof still
# observes that split-brain UI state.
#
# Exit codes:
#   0  the intended divergence reproduced
#   1  the focused divergence proof did not reproduce
#   2  repro setup failed

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-workflow-task-graph-status-divergence.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] Proving workflow metadata can diverge from selected task graph status."

set +e
pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  --reporter=verbose \
  src/__tests__/workflow-task-graph-status-divergence-repro.test.tsx \
  >"$LOG_FILE" 2>&1
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "[repro] PASS: workflow label and selected task graph status diverged as expected."
  exit 0
fi

echo "[repro] FAIL: focused divergence proof did not reproduce." >&2
cat "$LOG_FILE" >&2
exit 1
