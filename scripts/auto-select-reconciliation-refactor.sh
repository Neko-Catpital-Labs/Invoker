#!/usr/bin/env bash
# Auto-select reconciliation experiments containing "refactor" in their metadata.
# Intended to run from cron.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$REPO_ROOT/run.sh"
IPC_HELPER="$REPO_ROOT/scripts/headless-ipc.js"
LOCK_FILE="${TMPDIR:-/tmp}/invoker-auto-select-reconciliation-refactor.lock"

if [[ ! -x "$RUNNER" ]]; then
  echo "ERROR: missing executable runner at $RUNNER" >&2
  exit 1
fi

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "Another auto-select run is in progress; exiting."
    exit 0
  fi
fi

TASKS_JSONL="$($RUNNER --headless query tasks --output jsonl | grep '^{' || true)"
if [[ -z "$TASKS_JSONL" ]]; then
  echo "No tasks available."
  exit 0
fi

SELECTIONS="$({
  printf '%s\n' "$TASKS_JSONL"
} | jq -rs '
  . as $tasks
  | [
      $tasks[]
      | select(.config.isReconciliation == true and .status == "needs_input")
      | . as $recon
      | (
          [
            ($recon.execution.experimentResults // [])[]?
            | .id as $expId
            | {
                expId: $expId,
                hay: (
                  ($expId // "") + " "
                  + (.summary // "") + " "
                  + (([$tasks[] | select(.id == $expId) | .description][0]) // "")
                )
              }
            | select(.hay | test("refactor"; "i"))
            | .expId
          ]
          | .[0]
        ) as $winner
      | select($winner != null and $winner != "")
      | { reconId: $recon.id, winner: $winner }
    ]
  | .[]
  | "\(.reconId)\t\(.winner)"
')"

if [[ -z "$SELECTIONS" ]]; then
  echo "No reconciliation nodes with a refactor-named experiment found."
  exit 0
fi

attempts=0
success=0
failed=0

while IFS=$'\t' read -r recon_id experiment_id; do
  [[ -z "$recon_id" || -z "$experiment_id" ]] && continue
  attempts=$((attempts + 1))
  echo "Selecting experiment '$experiment_id' for reconciliation node '$recon_id'..."
  if node "$IPC_HELPER" exec --no-track -- select "$recon_id" "$experiment_id"; then
    success=$((success + 1))
  else
    failed=$((failed + 1))
  fi
done <<< "$SELECTIONS"

echo "Auto-select complete. attempted=$attempts succeeded=$success failed=$failed"
if [[ "$failed" -ne 0 ]]; then
  exit 1
fi
