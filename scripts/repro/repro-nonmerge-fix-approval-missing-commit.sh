#!/usr/bin/env bash
# Repro: non-merge AI fix approval completes task without committing the fix.
#
# Usage:
#   bash scripts/repro/repro-nonmerge-fix-approval-missing-commit.sh --expect bug
#   bash scripts/repro/repro-nonmerge-fix-approval-missing-commit.sh --expect fixed
#
# Exit codes:
#   0 - observed expected behavior for the selected mode
#   1 - behavior did not match expectation
#   2 - usage/environment error
set -euo pipefail

EXPECT="bug"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      if [[ $# -lt 2 ]]; then
        echo "repro: --expect requires bug|fixed" >&2
        exit 2
      fi
      EXPECT="$2"
      shift 2
      ;;
    *)
      echo "repro: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECT" != "bug" && "$EXPECT" != "fixed" ]]; then
  echo "repro: --expect must be bug or fixed" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-nonmerge-fix.XXXXXX")"
TMP_HOME="$TMP_DIR/home"
STUB_DIR="$TMP_DIR/stubs"
FIXTURE_DIR="$TMP_DIR/fixture"
OWNER_LOG="$TMP_DIR/owner.log"
SUBMIT_LOG="$TMP_DIR/submit.log"
PLAN_PATH="$TMP_DIR/repro-plan.yaml"
CONFIG_PATH="$TMP_DIR/config.json"
DB_PATH="$TMP_HOME/.invoker/invoker.db"
OWNER_PID=""

cleanup() {
  if [[ -n "$OWNER_PID" ]]; then
    kill "$OWNER_PID" 2>/dev/null || true
    wait "$OWNER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TMP_HOME/.invoker" "$STUB_DIR" "$FIXTURE_DIR"

cat >"$CONFIG_PATH" <<'EOF'
{
  "autoFixRetries": 1,
  "autoApproveAIFixes": true
}
EOF

cat >"$STUB_DIR/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SESSION_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-id)
      SESSION_ID="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -n "${INVOKER_REPRO_MARKER_DIR:-}" ]]; then
  mkdir -p "$INVOKER_REPRO_MARKER_DIR"
  printf '%s\n' "${SESSION_ID:-no-session}" >"$INVOKER_REPRO_MARKER_DIR/claude-ran.marker"
fi

printf 'FIXED\n' > fix-target.txt
echo "repro stub applied fix in $(pwd)"
EOF
chmod +x "$STUB_DIR/claude"

git -C "$FIXTURE_DIR" init -b master >/dev/null 2>&1
git -C "$FIXTURE_DIR" config user.email "repro@example.com"
git -C "$FIXTURE_DIR" config user.name "Repro Bot"
printf 'BROKEN\n' >"$FIXTURE_DIR/fix-target.txt"
cat >"$FIXTURE_DIR/package.json" <<'EOF'
{"name":"repro-fix-gap","private":true}
EOF
git -C "$FIXTURE_DIR" add fix-target.txt package.json
git -C "$FIXTURE_DIR" commit -m "seed repro fixture" >/dev/null 2>&1

REPO_URL="$(python3 - <<'PY' "$FIXTURE_DIR"
import pathlib, sys
print(pathlib.Path(sys.argv[1]).resolve().as_uri())
PY
)"

cat >"$PLAN_PATH" <<EOF
name: repro nonmerge fix approval missing commit
repoUrl: $REPO_URL
onFinish: none
tasks:
  - id: fix-gap
    description: Fail until AI edits fix-target.txt
    command: bash -lc 'test "\$(cat fix-target.txt)" = "FIXED"'
EOF

export HOME="$TMP_HOME"
export INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"
export INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK=1
export PATH="$STUB_DIR:$PATH"
export INVOKER_REPRO_MARKER_DIR="$TMP_DIR/markers"
unset INVOKER_HEADLESS_STANDALONE
unset INVOKER_DB_DIR

echo "==> repro: start owner"
unset ELECTRON_RUN_AS_NODE
./run.sh >"$OWNER_LOG" 2>&1 &
OWNER_PID=$!

echo "==> repro: wait for owner IPC socket"
READY=0
for _ in $(seq 1 240); do
  if find "$HOME/.invoker" -maxdepth 1 -type s -name 'ipc-tra*' | grep -q .; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "$READY" -ne 1 ]]; then
  echo "repro: owner never exposed ipc-transport socket" >&2
  cat "$OWNER_LOG" >&2
  exit 1
fi

echo "==> repro: submit plan"
./submit-plan.sh "$PLAN_PATH" 2>&1 | tee "$SUBMIT_LOG" || true
WF_ID="$(python3 - <<'PY' "$SUBMIT_LOG"
import re, sys
text = open(sys.argv[1], encoding='utf-8', errors='ignore').read()
matches = re.findall(r'wf-\d+-\d+', text)
print(matches[-1] if matches else '')
PY
)"
if [[ -z "$WF_ID" ]]; then
  echo "repro: failed to resolve workflow id from submit output" >&2
  cat "$SUBMIT_LOG" >&2
  exit 1
fi
TASK_ID="$WF_ID/fix-gap"

echo "==> repro: wait for task completion"
python3 - <<'PY' "$DB_PATH" "$TASK_ID"
import sqlite3, sys, time
db_path, task_id = sys.argv[1], sys.argv[2]
deadline = time.time() + 180
while time.time() < deadline:
    try:
        conn = sqlite3.connect(db_path)
        row = conn.execute(
            "select coalesce(status,''), coalesce(workspace_path,''), coalesce(commit_hash,''), coalesce(selected_attempt_id,'') "
            "from tasks where id = ? limit 1",
            (task_id,),
        ).fetchone()
        conn.close()
    except sqlite3.Error:
        row = None
    if row and row[0] in ("completed", "failed", "review_ready", "needs_input", "blocked", "stale"):
        print("\t".join(row))
        raise SystemExit(0)
    time.sleep(1)
raise SystemExit(1)
PY

IFS='|' read -r TASK_STATUS WORKSPACE_PATH TASK_COMMIT_HASH ATTEMPT_ID < <(
  python3 - <<'PY' "$DB_PATH" "$TASK_ID"
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
row = conn.execute(
    "select coalesce(status,''), coalesce(workspace_path,''), coalesce(commit_hash,''), coalesce(selected_attempt_id,'') "
    "from tasks where id = ? limit 1",
    (sys.argv[2],),
).fetchone()
conn.close()
if not row:
    raise SystemExit(1)
print("|".join(value.replace("|", "/") for value in row))
PY
)

if [[ "$TASK_STATUS" != "completed" ]]; then
  echo "repro: expected task to complete via auto-approved fix, got status=$TASK_STATUS" >&2
  sqlite3 -header -column "$DB_PATH" "select id, status, branch, commit_hash, workspace_path from tasks where workflow_id='$WF_ID' order by id;" >&2 || true
  exit 1
fi
if [[ -z "$WORKSPACE_PATH" || ! -d "$WORKSPACE_PATH" ]]; then
  echo "repro: task workspace path missing: $WORKSPACE_PATH" >&2
  exit 1
fi
if [[ ! -f "$TMP_DIR/markers/claude-ran.marker" ]]; then
  echo "repro: claude stub was not invoked" >&2
  exit 1
fi

IFS='|' read -r ATTEMPT_STATUS ATTEMPT_COMMIT_HASH TASK_BRANCH < <(
  python3 - <<'PY' "$DB_PATH" "$ATTEMPT_ID" "$TASK_ID"
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
attempt = conn.execute(
    "select coalesce(status,''), coalesce(commit_hash,''), coalesce(branch,'') from attempts where id = ? limit 1",
    (sys.argv[2],),
).fetchone()
if not attempt:
    task = conn.execute(
        "select '', '', coalesce(branch,'') from tasks where id = ? limit 1",
        (sys.argv[3],),
    ).fetchone()
    attempt = task
conn.close()
print("|".join(value.replace("|", "/") for value in attempt))
PY
)

WORKTREE_VALUE="$(tr -d '\r\n' <"$WORKSPACE_PATH/fix-target.txt")"
HEAD_VALUE="$(git -C "$WORKSPACE_PATH" show HEAD:fix-target.txt | tr -d '\r\n')"
HEAD_SHA="$(git -C "$WORKSPACE_PATH" rev-parse HEAD | tr -d '\r\n')"
DIRTY=0
if ! git -C "$WORKSPACE_PATH" diff --quiet -- fix-target.txt; then
  DIRTY=1
fi

REMOTE_SHA=""
if [[ -n "$TASK_BRANCH" ]]; then
  REMOTE_SHA="$(git -C "$WORKSPACE_PATH" rev-parse "$TASK_BRANCH" 2>/dev/null | tr -d '\r\n' || true)"
  if [[ -z "$REMOTE_SHA" ]]; then
    REMOTE_SHA="$(git -C "$WORKSPACE_PATH" rev-parse "origin/$TASK_BRANCH" 2>/dev/null | tr -d '\r\n' || true)"
  fi
fi

echo "==> repro summary"
echo "workflow:            $WF_ID"
echo "task:                $TASK_ID"
echo "status:              $TASK_STATUS"
echo "workspace:           $WORKSPACE_PATH"
echo "branch:              ${TASK_BRANCH:-<none>}"
echo "head sha:            ${HEAD_SHA:-<none>}"
echo "task commit_hash:    ${TASK_COMMIT_HASH:-<empty>}"
echo "attempt commit_hash: ${ATTEMPT_COMMIT_HASH:-<empty>}"
echo "remote sha:          ${REMOTE_SHA:-<none>}"
echo "worktree value:      $WORKTREE_VALUE"
echo "HEAD value:          $HEAD_VALUE"
echo "dirty:               $DIRTY"

if [[ "$EXPECT" = "bug" ]]; then
  if [[ "$WORKTREE_VALUE" = "FIXED" && "$HEAD_VALUE" != "FIXED" && "$DIRTY" -eq 1 ]]; then
    echo "repro: confirmed bug"
    exit 0
  fi
  echo "repro: expected dirty accepted fix without commit, but did not observe it" >&2
  exit 1
fi

if [[ "$WORKTREE_VALUE" = "FIXED" \
   && "$HEAD_VALUE" = "FIXED" \
   && "$DIRTY" -eq 0 \
   && -n "$TASK_COMMIT_HASH" \
   && -n "$ATTEMPT_COMMIT_HASH" \
   && "$TASK_COMMIT_HASH" = "$HEAD_SHA" \
   && "$ATTEMPT_COMMIT_HASH" = "$HEAD_SHA" ]] \
   && [[ -z "$REMOTE_SHA" || "$REMOTE_SHA" = "$HEAD_SHA" ]]; then
  echo "repro: confirmed fix"
  exit 0
fi

echo "repro: expected committed accepted fix, but observed stale/dirty state" >&2
exit 1
