#!/usr/bin/env bash
# Reproduce: "completed without branch metadata" on restart
#
# When a downstream task (task-b) is restarted after its upstream dependency
# (task-a) completed but lost its execution.branch, the guard at
# packages/executors/src/task-executor.ts:254-264 throws:
#
#   Error: Task "…/task-b": dependency "…/task-a" completed without
#   branch metadata — upstream changes would be silently dropped.
#
# This script reproduces that scenario in headless mode:
#   1. Run a 2-task plan (task-a → task-b) to completion
#   2. Corrupt task-a's branch to NULL via sqlite3
#   3. Restart task-b and verify the guard fires
#
# Requirements: sqlite3, git, built app (dist/main.js).
#
# Usage (from repo root):
#   bash scripts/repro-missing-branch-on-restart.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
E2E_FIXTURES="$REPO_ROOT/scripts/e2e-dry-run/fixtures"

# ── Prerequisites ──────────────────────────────────────────────

if ! command -v sqlite3 &>/dev/null; then
  echo "FAIL: sqlite3 is required to corrupt the DB between runs."
  exit 1
fi

if [[ ! -f "$REPO_ROOT/packages/app/dist/main.js" ]]; then
  echo "==> Building @invoker/app (dist missing)"
  (cd "$REPO_ROOT" && pnpm --filter @invoker/app build)
fi

# ── Isolated environment ──────────────────────────────────────

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"
export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-branch.XXXXXX")"
export INVOKER_E2E_MARKER_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-marker.XXXXXX")"

STUB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-stub.XXXXXX")"
ln -sf "$E2E_FIXTURES/claude-marker.sh" "$STUB_DIR/claude"
chmod +x "$E2E_FIXTURES/claude-marker.sh" 2>/dev/null || true
export PATH="$STUB_DIR:$PATH"

BARE_DIR=""
PLAN_FILE=""
RUN_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-run.XXXXXX.log")"
RESTART_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-restart.XXXXXX.log")"

# ── Cleanup ────────────────────────────────────────────────────

cleanup() {
  local ec=$?
  rm -f "$RUN_LOG" "$RESTART_LOG" 2>/dev/null || true
  [[ -n "${PLAN_FILE:-}" ]] && rm -f "$PLAN_FILE" 2>/dev/null || true
  rm -rf "$INVOKER_DB_DIR" "$INVOKER_E2E_MARKER_ROOT" "$STUB_DIR" 2>/dev/null || true
  [[ -n "${BARE_DIR:-}" ]] && rm -rf "$BARE_DIR" 2>/dev/null || true
  return "$ec"
}
trap cleanup EXIT

# ── Create local bare git repo ─────────────────────────────────

BARE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-barerepo.XXXXXX")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-work.XXXXXX")"

git init --bare "$BARE_DIR/bare.git" >/dev/null 2>&1
git clone "$BARE_DIR/bare.git" "$WORK" >/dev/null 2>&1
printf '%s\n' '{"name":"repro-branch","version":"1.0.0","private":true}' >"$WORK/package.json"
git -C "$WORK" add package.json
git -C "$WORK" -c user.email='repro@local' -c user.name='repro' commit -m 'initial' >/dev/null 2>&1
git -C "$WORK" push origin master >/dev/null 2>&1
rm -rf "$WORK"

REPO_URL="file://${BARE_DIR}/bare.git"

# ── Write plan YAML ────────────────────────────────────────────

PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-plan.XXXXXX.yaml")"
cat >"$PLAN_FILE" <<EOF
name: repro-missing-branch
repoUrl: ${REPO_URL}
onFinish: none
mergeMode: manual
baseBranch: master

tasks:
  - id: task-a
    description: "Upstream task"
    command: "echo upstream-ok"
  - id: task-b
    description: "Downstream depends on task-a"
    command: "echo downstream-ok"
    dependencies: [task-a]
EOF

unset ELECTRON_RUN_AS_NODE

echo "==> Invoker home (isolated): $INVOKER_DB_DIR"
echo "==> Plan repo: $REPO_URL"

# ── Step 1: Run plan to completion ─────────────────────────────

echo "==> Step 1: Running plan (both tasks should complete with branch metadata)"
(cd "$REPO_ROOT" && timeout 300 ./run.sh --headless run "$PLAN_FILE") 2>&1 | tee "$RUN_LOG"

# ── Step 2: Verify preconditions ───────────────────────────────

echo ""
echo "==> Step 2: Verifying preconditions in DB"

DB_PATH="$INVOKER_DB_DIR/invoker.db"

if [[ ! -f "$DB_PATH" ]]; then
  echo "FAIL: DB not found at $DB_PATH"
  exit 1
fi

TASK_A_STATUS="$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id LIKE '%/task-a';")"
TASK_A_BRANCH="$(sqlite3 "$DB_PATH" "SELECT branch FROM tasks WHERE id LIKE '%/task-a';")"
TASK_B_STATUS="$(sqlite3 "$DB_PATH" "SELECT status FROM tasks WHERE id LIKE '%/task-b';")"

echo "    task-a: status=$TASK_A_STATUS, branch=$TASK_A_BRANCH"
echo "    task-b: status=$TASK_B_STATUS"

if [[ "$TASK_A_STATUS" != "completed" ]]; then
  echo "FAIL: task-a not completed (status=$TASK_A_STATUS). Cannot proceed."
  exit 1
fi
if [[ -z "$TASK_A_BRANCH" ]]; then
  echo "FAIL: task-a has no branch after initial run — unexpected. Cannot test corruption."
  exit 1
fi
if [[ "$TASK_B_STATUS" != "completed" ]]; then
  echo "FAIL: task-b not completed (status=$TASK_B_STATUS). Cannot proceed."
  exit 1
fi

echo "    Preconditions OK."

# ── Step 3: Corrupt state — remove task-a's branch ─────────────

echo ""
echo "==> Step 3: Corrupting DB — setting task-a branch to NULL"
sqlite3 "$DB_PATH" "UPDATE tasks SET branch = NULL WHERE id LIKE '%/task-a';"

VERIFY_BRANCH="$(sqlite3 "$DB_PATH" "SELECT branch FROM tasks WHERE id LIKE '%/task-a';")"
if [[ -n "$VERIFY_BRANCH" ]]; then
  echo "FAIL: branch corruption did not stick (branch=$VERIFY_BRANCH)"
  exit 1
fi
echo "    Corruption applied. task-a branch is now NULL."

# Also reset task-b to pending so restart will attempt to execute it
echo "==> Resetting task-b to pending status"
sqlite3 "$DB_PATH" "UPDATE tasks SET status = 'pending' WHERE id LIKE '%/task-b';"

# ── Step 4: Restart task-b — expect the guard to fire ──────────

echo ""
echo "==> Step 4: Restarting task-b (should hit the 'completed without branch metadata' guard)"
RESTART_EC=0
(cd "$REPO_ROOT" && timeout 120 ./run.sh --headless restart task-b) >"$RESTART_LOG" 2>&1 || RESTART_EC=$?

echo "    restart exit code: $RESTART_EC"

# ── Step 5: Assert ─────────────────────────────────────────────

echo ""
echo "==> Step 5: Checking output for expected error"

if grep -q "completed without branch metadata" "$RESTART_LOG"; then
  echo ""
  echo "-------------------------------------------------------------------"
  echo "PASS"
  echo "  The guard at task-executor.ts:254 fired as expected."
  echo "  Error message found in restart output."
  echo "-------------------------------------------------------------------"
  exit 0
else
  echo ""
  echo "-------------------------------------------------------------------"
  echo "FAIL"
  echo "  Expected 'completed without branch metadata' in restart output."
  echo "  Restart exit code: $RESTART_EC"
  echo "  Full restart output:"
  cat "$RESTART_LOG"
  echo "-------------------------------------------------------------------"
  exit 1
fi
