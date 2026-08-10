#!/usr/bin/env bash
# End-to-end validation: a scratch: true plan runs through the real headless
# submit path with no git repo involved at all.
#
# Submits plans/verify-scratch-execution-headless.yaml (no repoUrl field)
# using a temp INVOKER_DB_DIR so the user's DB is never touched, then asserts
# the task completed with runnerKind=scratch and a workspace_path that sits
# outside this repo checkout (a plain OS temp directory).
#
# Usage (from repo root): bash scripts/verify-scratch-execution.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f packages/app/dist/main.js ]]; then
  echo "==> packages/app/dist/main.js missing — building..." >&2
  pnpm --filter @invoker/core build >&2
  pnpm --filter @invoker/persistence build >&2
  pnpm --filter @invoker/execution-engine build >&2
  pnpm --filter @invoker/surfaces build >&2
  pnpm --filter @invoker/ui build >&2
  pnpm --filter @invoker/app build >&2
fi

TMPDB="$(mktemp -d)"
trap 'rm -rf "$TMPDB"' EXIT

export INVOKER_DB_DIR="$TMPDB"
export INVOKER_HEADLESS_STANDALONE=1

echo "==> Using temp DB: $TMPDB"
PLAN="$ROOT/plans/verify-scratch-execution-headless.yaml"
echo "==> submit-plan (headless run) $PLAN"
./submit-plan.sh "$PLAN"

DB="$TMPDB/invoker.db"
if [[ -f "$DB" ]] && command -v sqlite3 >/dev/null 2>&1; then
  STATUS=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id LIKE '%/verify-scratch-command' LIMIT 1;")
  RUNNER_KIND=$(sqlite3 "$DB" "SELECT runner_kind FROM tasks WHERE id LIKE '%/verify-scratch-command' LIMIT 1;")
  WORKSPACE_PATH=$(sqlite3 "$DB" "SELECT workspace_path FROM tasks WHERE id LIKE '%/verify-scratch-command' LIMIT 1;")

  if [[ "$STATUS" != "completed" ]]; then
    echo "FAIL: expected scratch task to complete, got status='$STATUS'" >&2
    exit 1
  fi
  if [[ "$RUNNER_KIND" != "scratch" ]]; then
    echo "FAIL: expected persisted task runner_kind=scratch, got '$RUNNER_KIND'" >&2
    exit 1
  fi
  if [[ -z "$WORKSPACE_PATH" ]]; then
    echo "FAIL: expected a workspace_path for the scratch task, got empty" >&2
    exit 1
  fi
  case "$WORKSPACE_PATH" in
    "$ROOT"*)
      echo "FAIL: scratch task workspace_path is inside the repo checkout ($WORKSPACE_PATH); scratch mode must never use the repo" >&2
      exit 1
      ;;
  esac
  # A bare `run` (not `owner-serve`) never calls executor destroyAll() for
  # ANY executor type -- worktrees are not reclaimed after it either, per
  # verify-executor-routing.sh. So the scratch temp dir persisting here is
  # expected, not a leak; only owner-serve's shutdown path reclaims it.
  echo "PASS: scratch task completed with runner_kind=$RUNNER_KIND workspace_path=$WORKSPACE_PATH (outside repo)"
else
  echo "FAIL: expected a queryable sqlite DB at $DB" >&2
  exit 1
fi
