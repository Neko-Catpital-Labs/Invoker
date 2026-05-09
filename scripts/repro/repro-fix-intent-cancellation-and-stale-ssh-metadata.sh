#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION=""
KEEP_ARTIFACTS=0
TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-120}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-fix-intent-cancellation-and-stale-ssh-metadata.sh --expect bug|fixed [--keep-artifacts]

What it proves:
  Race 1 — Fix-intent cancellation:
    A running `invoker:fix-with-agent` mutation receives an AbortSignal when a
    higher-priority `invoker:recreate-task` preempts it, preventing stale fix
    side-effects from writing back to the database after the task has moved on.

  Race 2 — Stale SSH startup-failure metadata:
    When an SSH executor's startup failure returns after `selectedAttemptId` or
    `generation` has advanced, the stale `workspacePath` and `branch` metadata
    must NOT be persisted to the live task row.

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

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-fix-intent-stale-ssh.XXXXXX")"
LOG_FIX_INTENT="$TMP_DIR/fix-intent-cancellation.log"
LOG_STALE_SSH="$TMP_DIR/stale-ssh-metadata.log"

cleanup() {
  if [[ "$KEEP_ARTIFACTS" != "1" ]]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

die() {
  echo "repro: $*" >&2
  exit 2
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require_cmd pnpm
require_cmd timeout

cd "$ROOT_DIR"

# ── Race 1: Fix-intent cancellation ────────────────────────────────────
# Proves the AbortSignal fires when recreate-task preempts fix-with-agent.
echo "==> repro: Race 1 — fix-intent cancellation"

set +e
timeout "$TIMEOUT_SECONDS" \
  pnpm --filter @invoker/app exec vitest run \
    --reporter verbose \
    -t "aborts the dispatch AbortSignal when recreate-task preempts a running fix mutation" \
    src/__tests__/persisted-workflow-mutation-coordinator.test.ts \
  >"$LOG_FIX_INTENT" 2>&1
FIX_INTENT_STATUS=$?
set -e

FIX_INTENT_OBSERVED=""
if [[ "$FIX_INTENT_STATUS" -eq 0 ]]; then
  FIX_INTENT_OBSERVED="fixed"
else
  FIX_INTENT_OBSERVED="bug"
fi

echo "fix_intent_exit   : $FIX_INTENT_STATUS"
echo "fix_intent_observed : $FIX_INTENT_OBSERVED"

# ── Race 2: Stale SSH startup-failure metadata ─────────────────────────
# Proves stale metadata is NOT persisted when selectedAttemptId has advanced.
echo "==> repro: Race 2 — stale SSH startup-failure metadata"

set +e
timeout "$TIMEOUT_SECONDS" \
  pnpm --filter @invoker/execution-engine exec vitest run \
    --reporter verbose \
    -t "suppresses metadata write and failed response when selectedAttemptId has advanced" \
    src/__tests__/task-runner.test.ts \
  >"$LOG_STALE_SSH" 2>&1
STALE_SSH_STATUS=$?
set -e

STALE_SSH_OBSERVED=""
if [[ "$STALE_SSH_STATUS" -eq 0 ]]; then
  STALE_SSH_OBSERVED="fixed"
else
  STALE_SSH_OBSERVED="bug"
fi

echo "stale_ssh_exit      : $STALE_SSH_STATUS"
echo "stale_ssh_observed  : $STALE_SSH_OBSERVED"

# ── Aggregate result ──────────────────────────────────────────────────
echo "==> repro summary"

OVERALL=""
if [[ "$FIX_INTENT_OBSERVED" == "fixed" && "$STALE_SSH_OBSERVED" == "fixed" ]]; then
  OVERALL="fixed"
else
  OVERALL="bug"
fi

echo "race1_fix_intent  : $FIX_INTENT_OBSERVED"
echo "race2_stale_ssh   : $STALE_SSH_OBSERVED"
echo "overall_observed  : $OVERALL"
echo "expected          : $EXPECTATION"
echo "artifacts         : $TMP_DIR"

if [[ "$OVERALL" != "$EXPECTATION" ]]; then
  echo "==> repro mismatch"
  echo "--- fix-intent log ---" >&2
  cat "$LOG_FIX_INTENT" >&2 || true
  echo "--- stale-ssh log ---" >&2
  cat "$LOG_STALE_SSH" >&2 || true
  exit 1
fi

echo "==> repro matched expectation"
exit 0
