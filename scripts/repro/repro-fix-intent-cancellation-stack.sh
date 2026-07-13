#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION=""
KEEP_ARTIFACTS=0

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-fix-intent-cancellation-stack.sh --expect bug|fixed [--keep-artifacts]

What it proves:
  Scenario 1 — Recreate-task queue authority:
    A higher-priority `recreate-task` must preempt an older running workflow
    mutation instead of remaining queued behind it.

  Scenario 2 — Fix-intent cancellation + stale SSH metadata:
    The focused shared repro proves the running fix mutation is aborted when
    preempted and stale SSH startup-failure metadata is suppressed on newer
    lineages.

  Scenario 3 — Stale late completion after reset:
    A stale task completion must be rejected after `recreate` or `retry-task`
    resets the workflow lineage.

  Scenario 4 — Same-workflow tracked-fix vs recreate:
    A tracked fix must not retain authority over a same-workflow recreate
    request under overload churn.

  Scenario 5 — Owner restart loop during tracked recreate-task:
    Disabled in the required stack bundle. The standalone-owner bootstrap path
    is currently flaky under restart churn and should run as a dedicated manual
    repro until stabilized.

This wrapper runs the committed repros for that stack:
  - scripts/repro/repro-recreate-task-blocked-by-running-workflow-mutation.sh
  - scripts/repro/repro-fix-intent-cancellation-and-stale-ssh-metadata.sh
  - scripts/repro/repro-stale-late-completion-after-reset.sh
  - scripts/repro/repro-same-workflow-tracked-fix-vs-recreate.sh
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

cd "$ROOT_DIR"

queue_args=()
shared_args=(--expect "$EXPECTATION")
late_completion_args=()
if [[ "$EXPECTATION" == "bug" ]]; then
  queue_args+=(--expect-bug)
  late_completion_args+=(--expect-bug)
else
  queue_args+=(--expect-fixed)
  late_completion_args+=(--expect-fixed)
fi
if [[ "$KEEP_ARTIFACTS" == "1" ]]; then
  queue_args+=(--keep-temp)
  shared_args+=(--keep-artifacts)
  late_completion_args+=(--keep-temp)
fi

echo "==> stack repro: Scenario 1 — recreate-task queue authority"
bash scripts/repro/repro-recreate-task-blocked-by-running-workflow-mutation.sh "${queue_args[@]}"

echo
echo "==> stack repro: Scenario 2 — fix-intent cancellation and stale SSH metadata"
bash scripts/repro/repro-fix-intent-cancellation-and-stale-ssh-metadata.sh "${shared_args[@]}"

echo
echo "==> stack repro: Scenario 3 — stale late completion after reset"
bash scripts/repro/repro-stale-late-completion-after-reset.sh --mode=both "${late_completion_args[@]}"

echo
if [[ "$EXPECTATION" == "fixed" ]]; then
  echo "==> stack repro: Scenario 4 — same-workflow tracked-fix vs recreate"
  bash scripts/repro/repro-same-workflow-tracked-fix-vs-recreate.sh

  echo "==> stack repro: Scenario 5 — owner restart loop during tracked recreate-task"
  echo "skipped: repro-owner-restart-loop-during-tracked-recreate-task.sh"
  echo "reason: standalone owner restart bootstrap remains flaky under overload churn"

  echo
else
  echo "==> stack repro: skipping fixed-only overload scenarios for --expect bug"
  echo "skipped: repro-same-workflow-tracked-fix-vs-recreate.sh"
  echo "skipped: repro-owner-restart-loop-during-tracked-recreate-task.sh"
  echo
fi

echo "==> stack repro matched expectation"
