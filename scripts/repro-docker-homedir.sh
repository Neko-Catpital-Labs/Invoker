#!/usr/bin/env zsh
# Repro script for Docker home-dir permissions bug.
#
# The Dockerfile creates /home/invoker owned by UID 1000, but containers
# run as the host UID (e.g. 501 on macOS). Any write to ~/.cache fails
# with EACCES, which crashes corepack and pnpm.
#
# Usage:
#   ./scripts/repro-docker-homedir.sh
#
# Exit codes:
#   1 — bug reproduced (EACCES found in task output)
#   0 — bug not reproduced / fixed (HOMEDIR_OK found)
#   2 — unexpected result
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DB_PATH="$HOME/.invoker/invoker.db"
PLAN_FILE="$REPO_ROOT/scripts/repro-docker-homedir.yaml"
TASK_ID="homedir-write"

echo "==> Step 1: Rebuilding Docker image from current Dockerfile"
docker build -t invoker-agent:latest -f packages/executors/docker/Dockerfile.claude packages/executors/docker/

echo "==> Step 2: Clearing Invoker DB"
./run.sh --headless delete-all

echo "==> Step 3: Submitting repro plan"
./submit-plan.sh "$PLAN_FILE"

echo "==> Step 4: Querying task output"
if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: DB not found at $DB_PATH"
  exit 2
fi

OUTPUT=$(sqlite3 "$DB_PATH" "SELECT data FROM task_output WHERE task_id = '$TASK_ID' ORDER BY id ASC;")

if [ -z "$OUTPUT" ]; then
  echo "ERROR: No task output found for task_id='$TASK_ID'"
  exit 2
fi

echo "--- Task output ---"
echo "$OUTPUT"
echo "-------------------"

if echo "$OUTPUT" | grep -qi "EACCES\|Permission denied"; then
  echo ""
  echo "BUG REPRODUCED: EACCES / Permission denied found in task output"
  exit 1
fi

if echo "$OUTPUT" | grep -q "HOMEDIR_OK"; then
  echo ""
  echo "BUG FIXED: mkdir succeeded, HOMEDIR_OK found in task output"
  exit 0
fi

echo ""
echo "UNEXPECTED: task output did not contain EACCES or HOMEDIR_OK"
exit 2
