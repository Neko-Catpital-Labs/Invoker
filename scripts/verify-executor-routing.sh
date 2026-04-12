#!/usr/bin/env bash
# End-to-end validation: executor routing via INVOKER_REPO_CONFIG_PATH.
#
# Submits plans/verify-executor-routing-headless.yaml with a fixture config
# (plans/verify-executor-routing.invoker.json) that contains executorRoutingRules
# and a dummy remoteTargets entry.  Uses a temp INVOKER_DB_DIR so the user's DB
# is never touched.  Never calls delete-all.
#
# INVOKER_REPO_CONFIG_PATH overrides the .invoker.json path inside loadConfig,
# allowing fixture configs to be injected without clobbering the checked-in file.
#
# Usage (from repo root): bash scripts/verify-executor-routing.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f packages/app/dist/main.js ]]; then
  echo "ERROR: packages/app/dist/main.js missing — run: pnpm --filter @invoker/app build" >&2
  exit 1
fi

TMPDB="$(mktemp -d)"
PLAN_TMP=""
trap 'rm -rf "$TMPDB"; rm -f "${PLAN_TMP:-}"' EXIT

export INVOKER_DB_DIR="$TMPDB"
export INVOKER_REPO_CONFIG_PATH="$ROOT/plans/verify-executor-routing.invoker.json"
export INVOKER_HEADLESS_STANDALONE=1

echo "==> Using temp DB: $TMPDB"
echo "==> Using fixture config: $INVOKER_REPO_CONFIG_PATH"
PLAN_SRC="$ROOT/plans/verify-executor-routing-headless.yaml"
PLAN_TMP="$(mktemp "${TMPDIR:-/tmp}/verify-exec-routing.XXXXXX")"
python3 -c "
import pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
src, dest = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
text = src.read_text(encoding='utf-8')
out = []
for line in text.splitlines():
    if line.lstrip().startswith('repoUrl:'):
        out.append('repoUrl: ' + root.as_uri())
    else:
        out.append(line)
nl = chr(10)
dest.write_text(nl.join(out) + (nl if text.endswith('\n') else ''), encoding='utf-8')
" "$ROOT" "$PLAN_SRC" "$PLAN_TMP"
echo "==> submit-plan (headless run) $PLAN_SRC (repoUrl -> file:// checkout)"
./submit-plan.sh "$PLAN_TMP"

# Assert executor_type and remote_target_id in SQLite if sqlite3 is available and
# the columns exist (schema may evolve). Task IDs are workflow-scoped.
DB="$TMPDB/invoker.db"
if [[ -f "$DB" ]] && command -v sqlite3 >/dev/null 2>&1; then
  COLS=$(sqlite3 "$DB" "PRAGMA table_info(tasks);" | cut -d'|' -f2)
  if echo "$COLS" | grep -q '^executor_type$'; then
    FT=$(sqlite3 "$DB" "SELECT executor_type FROM tasks WHERE id LIKE '%/verify-routing-command' LIMIT 1;")
    if [[ "$FT" != "worktree" ]]; then
      echo "FAIL: expected executor_type=worktree for validated routing task, got '$FT'" >&2
      exit 1
    fi
    echo "PASS: executor_type=$FT (routing validation succeeded)"

    # If remote_target_id column exists, assert it too
    if echo "$COLS" | grep -q '^remote_target_id$'; then
      RT=$(sqlite3 "$DB" "SELECT remote_target_id FROM tasks WHERE id LIKE '%/verify-routing-command' LIMIT 1;")
      if [[ "$RT" != "dummy-target" ]]; then
        echo "FAIL: expected remote_target_id=dummy-target, got '$RT'" >&2
        exit 1
      fi
      echo "PASS: remote_target_id=$RT"
    fi
  else
    echo "INFO: executor_type column not present; skipping SQLite assertion"
  fi
fi
