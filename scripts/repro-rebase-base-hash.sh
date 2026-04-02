#!/usr/bin/env bash
# Repro: verify rebase-and-retry actually picks up a new HEAD after the base
# branch advances.
#
# Creates an isolated file:// repo, runs a single-task plan, advances master,
# then runs rebase-and-retry and asserts the task's merge-base moved forward.
#
# Requirements: python3, git, built app (dist/main.js).
# No network needed (file:// URL).
#
# Usage (from repo root):
#   bash scripts/repro-rebase-base-hash.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
E2E_FIXTURES="$REPO_ROOT/scripts/e2e-dry-run/fixtures"

if ! command -v python3 &>/dev/null; then
  echo "FAIL: python3 is required to read invoker.db between processes."
  exit 1
fi

if [[ ! -f "$REPO_ROOT/packages/app/dist/main.js" ]]; then
  echo "==> Building @invoker/app (dist missing)"
  (cd "$REPO_ROOT" && pnpm --filter @invoker/app build)
fi

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"
export INVOKER_HEADLESS_STANDALONE=1

# Isolated Invoker home (DB + repos + worktrees).
export INVOKER_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-base-hash.XXXXXX")"
export INVOKER_E2E_MARKER_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-marker.XXXXXX")"
STUB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-stub.XXXXXX")"
ln -sf "$E2E_FIXTURES/claude-marker.sh" "$STUB_DIR/claude"
chmod +x "$E2E_FIXTURES/claude-marker.sh" 2>/dev/null || true
export PATH="$STUB_DIR:$PATH"

WF_ID=""
SOURCE_DIR=""
PLAN_FILE=""
RUN_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-run.XXXXXX.log")"
REBASE_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-rebase.XXXXXX.log")"

cleanup() {
  local ec=$?
  if [[ -n "$WF_ID" ]]; then
    echo "==> Cleanup: delete-workflow $WF_ID"
    (cd "$REPO_ROOT" && INVOKER_HEADLESS_STANDALONE=1 INVOKER_DB_DIR="$INVOKER_DB_DIR" PATH="$STUB_DIR:$PATH" \
      INVOKER_E2E_MARKER_ROOT="$INVOKER_E2E_MARKER_ROOT" \
      timeout 120 ./run.sh --headless delete-workflow "$WF_ID") 2>/dev/null || true
  fi
  rm -f "$RUN_LOG" "$REBASE_LOG" 2>/dev/null || true
  [[ -n "${PLAN_FILE:-}" ]] && rm -f "$PLAN_FILE" 2>/dev/null || true
  rm -rf "$INVOKER_DB_DIR" "$INVOKER_E2E_MARKER_ROOT" "$STUB_DIR" 2>/dev/null || true
  [[ -n "${SOURCE_DIR:-}" ]] && rm -rf "$SOURCE_DIR" 2>/dev/null || true
  return "$ec"
}
trap cleanup EXIT

# ── Step 1: Create temp repo ──────────────────────────────────
SOURCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-src.XXXXXX")"
git init "$SOURCE_DIR"
git -C "$SOURCE_DIR" checkout -b master
printf '%s\n' '{"name":"repro-base-hash","version":"1.0.0","private":true}' >"$SOURCE_DIR/package.json"
echo "initial" >"$SOURCE_DIR/file.txt"
git -C "$SOURCE_DIR" add .
git -C "$SOURCE_DIR" -c user.email='repro@local' -c user.name='repro' commit -m 'initial commit'

# ── Step 2: Record MASTER_SHA_BEFORE ──────────────────────────
MASTER_SHA_BEFORE="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
REPO_URL="file://${SOURCE_DIR}"
echo "==> MASTER_SHA_BEFORE: $MASTER_SHA_BEFORE"
echo "==> Source repo:       $REPO_URL"

# ── Step 3: Write plan YAML ──────────────────────────────────
PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-plan.XXXXXX.yaml")"
cat >"$PLAN_FILE" <<EOF
name: repro base hash after rebase
repoUrl: ${REPO_URL}
onFinish: none
mergeMode: manual
baseBranch: master

tasks:
  - id: repro-task
    description: Simple command to produce a branch
    command: echo done
    dependencies: []
EOF

unset ELECTRON_RUN_AS_NODE

echo "==> Invoker home (isolated): $INVOKER_DB_DIR"

# ── Step 4: First run ────────────────────────────────────────
echo "==> First run: load plan + execute to completion"
(cd "$REPO_ROOT" && timeout 600 ./run.sh --headless run "$PLAN_FILE") 2>&1 | tee "$RUN_LOG"

WF_ID="$(grep -E '^Workflow ID: ' "$RUN_LOG" | head -1 | sed 's/^Workflow ID: //' | tr -d '\r')"
if [[ -z "$WF_ID" ]]; then
  echo "FAIL: could not parse Workflow ID from run log. See $RUN_LOG"
  exit 1
fi
echo "==> Workflow ID: $WF_ID"

# ── Step 5: Read task branch + resolve BASE_SHA_BEFORE ───────
TASK_BRANCH_BEFORE="$(INVOKER_DB_DIR="$INVOKER_DB_DIR" python3 -c "
import os, sqlite3
db = os.path.join(os.environ['INVOKER_DB_DIR'], 'invoker.db')
con = sqlite3.connect(db)
row = con.execute(
    \"SELECT branch FROM tasks WHERE id LIKE '%/repro-task'\",
).fetchone()
con.close()
print((row[0] or '') if row else '', end='')
")"

if [[ -z "$TASK_BRANCH_BEFORE" ]]; then
  echo "FAIL: repro-task has no branch after first run."
  exit 1
fi
echo "==> Task branch (before): $TASK_BRANCH_BEFORE"

# Pool mirror path: $INVOKER_DB_DIR/repos/<sha256(repoUrl)[0:12]>
POOL_MIRROR="$(INVOKER_DB_DIR="$INVOKER_DB_DIR" REPO_URL="$REPO_URL" python3 -c "
import os, hashlib
db_dir = os.environ['INVOKER_DB_DIR']
url = os.environ['REPO_URL']
h = hashlib.sha256(url.encode()).hexdigest()[:12]
print(os.path.join(db_dir, 'repos', h), end='')
")"
echo "==> Pool mirror: $POOL_MIRROR"

if [[ ! -d "$POOL_MIRROR" ]]; then
  echo "FAIL: pool mirror directory does not exist at $POOL_MIRROR"
  exit 1
fi

BASE_SHA_BEFORE="$(git -C "$POOL_MIRROR" merge-base origin/master "$TASK_BRANCH_BEFORE" 2>/dev/null || echo '')"
if [[ -z "$BASE_SHA_BEFORE" ]]; then
  echo "FAIL: could not resolve merge-base before rebase."
  echo "  Branches in pool mirror:"
  git -C "$POOL_MIRROR" branch -a 2>/dev/null || true
  exit 1
fi
echo "==> BASE_SHA_BEFORE: $BASE_SHA_BEFORE"

# ── Step 6: Advance master in source repo ────────────────────
echo "more content" >>"$SOURCE_DIR/file.txt"
git -C "$SOURCE_DIR" add .
git -C "$SOURCE_DIR" -c user.email='repro@local' -c user.name='repro' commit -m 'advance master'
MASTER_SHA_AFTER="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
echo "==> MASTER_SHA_AFTER: $MASTER_SHA_AFTER"

if [[ "$MASTER_SHA_BEFORE" == "$MASTER_SHA_AFTER" ]]; then
  echo "FAIL: master did not advance (sanity check)."
  exit 1
fi

# ── Step 7: Run rebase-and-retry ─────────────────────────────
echo "==> Running rebase-and-retry for repro-task..."
(cd "$REPO_ROOT" && timeout 600 ./run.sh --headless rebase-and-retry repro-task) 2>&1 | tee "$REBASE_LOG"

# ── Step 8: Read new branch + resolve BASE_SHA_AFTER ─────────
TASK_BRANCH_AFTER="$(INVOKER_DB_DIR="$INVOKER_DB_DIR" python3 -c "
import os, sqlite3
db = os.path.join(os.environ['INVOKER_DB_DIR'], 'invoker.db')
con = sqlite3.connect(db)
row = con.execute(
    \"SELECT branch FROM tasks WHERE id LIKE '%/repro-task'\",
).fetchone()
con.close()
print((row[0] or '') if row else '', end='')
")"

if [[ -z "$TASK_BRANCH_AFTER" ]]; then
  echo "FAIL: repro-task has no branch after rebase."
  exit 1
fi
echo "==> Task branch (after): $TASK_BRANCH_AFTER"

BASE_SHA_AFTER="$(git -C "$POOL_MIRROR" merge-base origin/master "$TASK_BRANCH_AFTER" 2>/dev/null || echo '')"
if [[ -z "$BASE_SHA_AFTER" ]]; then
  echo "FAIL: could not resolve merge-base after rebase."
  echo "  Branches in pool mirror:"
  git -C "$POOL_MIRROR" branch -a 2>/dev/null || true
  exit 1
fi
echo "==> BASE_SHA_AFTER: $BASE_SHA_AFTER"

# ── Step 9: Assert ───────────────────────────────────────────
echo ""
echo "-------------------------------------------------------------------"
echo "  MASTER_SHA_BEFORE:  $MASTER_SHA_BEFORE"
echo "  MASTER_SHA_AFTER:   $MASTER_SHA_AFTER"
echo "  BASE_SHA_BEFORE:    $BASE_SHA_BEFORE"
echo "  BASE_SHA_AFTER:     $BASE_SHA_AFTER"
echo "-------------------------------------------------------------------"

if [[ "$BASE_SHA_BEFORE" == "$BASE_SHA_AFTER" ]]; then
  echo ""
  echo "FAIL: BASE_SHA did not change after rebase-and-retry."
  echo "  rebase-and-retry did NOT pick up the new master HEAD."
  exit 1
fi

if [[ "$BASE_SHA_AFTER" != "$MASTER_SHA_AFTER" ]]; then
  echo ""
  echo "FAIL: BASE_SHA_AFTER ($BASE_SHA_AFTER) != MASTER_SHA_AFTER ($MASTER_SHA_AFTER)."
  echo "  rebase-and-retry picked up a different commit than expected."
  exit 1
fi

echo ""
echo "PASS: rebase-and-retry correctly rebased onto new master HEAD."
echo "  BASE_SHA changed from $BASE_SHA_BEFORE to $BASE_SHA_AFTER"
exit 0
