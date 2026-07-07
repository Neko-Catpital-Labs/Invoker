#!/usr/bin/env bash
set -euo pipefail

# Bug-only repro for the approval modal stale task snapshot.
#
# The renderer bug: ApprovalModal receives the TaskState captured when the modal
# opens. A later task graph refresh can update the selected task inspector while
# the open modal remains bound to the old TaskState snapshot.
#
# Exit codes:
#   0  the stale modal binding reproduced
#   1  the focused proof did not reproduce

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-approval-modal-stale-refresh.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] Proving an open approval modal can stay bound to an old task snapshot."

set +e
pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  --reporter=verbose \
  src/__tests__/approval-modal-stale-task-refresh-repro.test.tsx \
  >"$LOG_FILE" 2>&1
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "[repro] PASS: approval modal stayed bound to the old task snapshot after refresh."
  exit 0
fi

echo "[repro] FAIL: focused stale-modal proof did not reproduce." >&2
cat "$LOG_FILE" >&2
exit 1
