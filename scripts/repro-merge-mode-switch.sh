#!/usr/bin/env bash
# Reproduction: merge mode switch from manual → github
#
# Tests whether the DB correctly stores 'external_review' after switching
# via the headless set-merge-mode command (same codepath as GUI IPC).
#
# Run from invoker-v2 repo root:
#   bash scripts/repro-merge-mode-switch.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Setup (isolated DB, stub binaries) ───────────────────────

cleanup() {
  echo ""
  echo "── Cleanup ──"
  [ -n "${DB_DIR:-}" ] && rm -rf "$DB_DIR" && echo "  removed DB_DIR=$DB_DIR"
  [ -n "${STUB_DIR:-}" ] && rm -rf "$STUB_DIR" && echo "  removed STUB_DIR=$STUB_DIR"
  git -C "$REPO_ROOT" worktree prune 2>/dev/null || true
  pkill -f "electron.*--headless" 2>/dev/null || true
}
trap cleanup EXIT

export INVOKER_HEADLESS_STANDALONE=1
DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-mm.XXXXXX")"
export INVOKER_DB_DIR="$DB_DIR"

STUB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-mm-stub.XXXXXX")"
E2E_FIXTURE_DIR="$REPO_ROOT/scripts/e2e-dry-run/fixtures"
if [ -f "$E2E_FIXTURE_DIR/claude-marker.sh" ]; then
  ln -sf "$E2E_FIXTURE_DIR/claude-marker.sh" "$STUB_DIR/claude"
  chmod +x "$E2E_FIXTURE_DIR/claude-marker.sh" 2>/dev/null || true
fi
if [ -f "$E2E_FIXTURE_DIR/gh-marker.sh" ]; then
  ln -sf "$E2E_FIXTURE_DIR/gh-marker.sh" "$STUB_DIR/gh"
  chmod +x "$E2E_FIXTURE_DIR/gh-marker.sh" 2>/dev/null || true
fi
export PATH="$STUB_DIR:$PATH"
export INVOKER_CLAUDE_FIX_COMMAND="$STUB_DIR/claude"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"
unset ELECTRON_RUN_AS_NODE

TIMEOUT_SEC=120

run_headless() {
  timeout "${TIMEOUT_SEC}s" "$REPO_ROOT/run.sh" --headless "$@"
}

# ── Step 0: Verify build ─────────────────────────────────────

echo "── Step 0: Check build ──"
if [ ! -f "$REPO_ROOT/packages/app/dist/main.js" ]; then
  echo "  FAIL: dist/main.js missing. Run: pnpm --filter @invoker/app build"
  exit 1
fi
echo "  OK"

# ── Step 1: Submit a plan (task succeeds, merge gate becomes awaiting_approval) ──

echo ""
echo "── Step 1: Submit plan with mergeMode=manual ──"
PLAN="$REPO_ROOT/plans/e2e-dry-run/group1-single-task/1.1-success.yaml"
run_headless delete-all 2>&1 | grep -v '^\[' || true
run_headless run "$PLAN" 2>&1 | grep -v '^\[' || true

# Find workflow ID and merge gate task ID
WF_ID=$(run_headless status 2>/dev/null | grep -oP 'wf-[0-9]+-[0-9]+' | head -1 | sed 's/\x1b\[[0-9;]*m//g')
MERGE_ID=$(run_headless status 2>/dev/null | grep -oP '__merge__[^\s]+' | head -1 | sed 's/\x1b\[[0-9;]*m//g')

echo "  workflow: $WF_ID"
echo "  merge gate: $MERGE_ID"

if [ -z "$WF_ID" ] || [ -z "$MERGE_ID" ]; then
  echo "FAIL: could not find workflow or merge gate"
  run_headless status 2>&1
  exit 1
fi

# Check initial merge mode from the status output
echo ""
echo "── Step 2: Query initial merge mode ──"
INITIAL_OUTPUT=$(run_headless set-merge-mode "$WF_ID" manual 2>&1)
INITIAL_MODE=$(echo "$INITIAL_OUTPUT" | grep -oP 'Merge mode updated.*:\s*\K\S+' || echo "?")
echo "  initial mergeMode in DB: $INITIAL_MODE"

# ── Step 3: Switch merge mode to 'github' (what the UI sends) ──

echo ""
echo "── Step 3: set-merge-mode $WF_ID github ──"
SWITCH_OUTPUT=$(run_headless set-merge-mode "$WF_ID" github 2>&1)
echo "  output:"
echo "$SWITCH_OUTPUT" | grep -v '^\[' | sed 's/^/    /'

# Extract the stored merge mode
STORED_MODE=$(echo "$SWITCH_OUTPUT" | grep -oP 'Merge mode updated.*:\s*\K\S+' || echo "?")
echo "  stored mergeMode in DB: $STORED_MODE"

# ── Step 4: Diagnosis ────────────────────────────────────────

echo ""
echo "── Step 4: Diagnosis ──"

if [ "$STORED_MODE" = "external_review" ]; then
  echo "  DB stores 'external_review' after set-merge-mode github."
  echo "  This is correct — the backend normalizes 'github' → 'external_review'."
  echo ""
  echo "  BUG IS IN THE UI:"
  echo "    TaskPanel.tsx <select> has <option value=\"github\">GitHub</option>"
  echo "    but the workflow.mergeMode coming back from DB is 'external_review'."
  echo "    Since no <option> has value=\"external_review\", the <select> falls"
  echo "    back to showing the first option ('Manual')."
  echo ""
  echo "    Fix: map 'external_review' back to 'github' in the select's value prop,"
  echo "    or add an <option value=\"external_review\">."
  exit 0
elif [ "$STORED_MODE" = "github" ]; then
  echo "  DB stores raw 'github' — normalization is broken."
  echo "  BUG IS IN THE BACKEND."
  exit 1
elif [ "$STORED_MODE" = "manual" ]; then
  echo "  DB still shows 'manual' — the update didn't persist."
  echo "  BUG IS IN THE BACKEND."
  exit 1
else
  echo "  Unexpected mergeMode: '$STORED_MODE'"
  echo "  Full output:"
  echo "$SWITCH_OUTPUT" | sed 's/^/    /'
  exit 1
fi
