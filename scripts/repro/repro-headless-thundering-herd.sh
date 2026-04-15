#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
IPC_SOCKET="$TMP_DIR/ipc-transport.sock"
PLAN_PATH="$TMP_DIR/herd-plan.yaml"
CONFIG_PATH="$TMP_DIR/config.json"
REMOTE_REPO="$TMP_DIR/remote.git"
RUN_STDOUT="$TMP_DIR/run.stdout.log"
RUN_STDERR="$TMP_DIR/run.stderr.log"
BURST="${BURST:-8}"

cleanup() {
  pkill -f "electron.*packages/app/dist/main.js.*--headless owner-serve" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$DB_DIR"

pushd "$ROOT_DIR" >/dev/null

if [[ ! -f packages/app/dist/headless-client.js ]]; then
  pnpm --filter @invoker/app build >/dev/null
fi

git init --bare "$REMOTE_REPO" >/dev/null 2>&1

cat > "$PLAN_PATH" <<'EOF'
name: Headless Thundering Herd Repro
onFinish: none
tasks:
  - id: root
    description: Root task
    command: echo root
EOF

python3 - "$PLAN_PATH" "$REMOTE_REPO" <<'PY'
from pathlib import Path
import sys
plan_path = Path(sys.argv[1])
remote_repo = Path(sys.argv[2]).as_uri()
contents = plan_path.read_text()
plan_path.write_text(contents.replace("name: Headless Thundering Herd Repro\n", f"name: Headless Thundering Herd Repro\nrepoUrl: {remote_repo}\n", 1))
PY

cat > "$CONFIG_PATH" <<'EOF'
{"autoFixRetries":0,"maxConcurrency":4}
EOF

COMMON_ENV=(
  HOME="$HOME_DIR"
  INVOKER_DB_DIR="$DB_DIR"
  INVOKER_IPC_SOCKET="$IPC_SOCKET"
  INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"
)

env INVOKER_HEADLESS_STANDALONE=1 "${COMMON_ENV[@]}" ./run.sh --headless --no-track run "$PLAN_PATH" >"$RUN_STDOUT" 2>"$RUN_STDERR"
WORKFLOW_ID="$(sed -n 's/^Workflow ID: //p' "$RUN_STDOUT" | head -n1)"
if [[ -z "$WORKFLOW_ID" ]]; then
  echo "repro: failed to create workflow id" >&2
  cat "$RUN_STDOUT" >&2 || true
  cat "$RUN_STDERR" >&2 || true
  exit 1
fi

for i in $(seq 1 "$BURST"); do
  env "${COMMON_ENV[@]}" ./run.sh --headless --no-track restart "$WORKFLOW_ID" \
    >"$TMP_DIR/restart-$i.stdout.log" 2>"$TMP_DIR/restart-$i.stderr.log" &
done
wait

OWNER_SERVE_COUNT="$(( $( (pgrep -af '[e]lectron/dist/electron .*packages/app/dist/main.js.*--headless owner-serve' || true) | wc -l | tr -d ' ' ) ))"
HEADLESS_RESTART_ELECTRONS="$(( $( (pgrep -af "[e]lectron/dist/electron .*packages/app/dist/main.js.*--headless restart ${WORKFLOW_ID}" || true) | wc -l | tr -d ' ' ) ))"

if [[ "$OWNER_SERVE_COUNT" -gt 1 ]]; then
  echo "repro: expected at most one standalone owner, saw $OWNER_SERVE_COUNT" >&2
  pgrep -af '[e]lectron/dist/electron .*packages/app/dist/main.js.*--headless owner-serve' >&2 || true
  exit 1
fi

if [[ "$HEADLESS_RESTART_ELECTRONS" -ne 0 ]]; then
  echo "repro: expected zero headless restart electron processes, saw $HEADLESS_RESTART_ELECTRONS" >&2
  pgrep -af "[e]lectron/dist/electron .*packages/app/dist/main.js.*--headless restart ${WORKFLOW_ID}" >&2 || true
  exit 1
fi

echo "repro: confirmed headless burst uses a single shared owner"
echo "workflow: $WORKFLOW_ID"
echo "owner-serve-count: $OWNER_SERVE_COUNT"
echo "headless-restart-electrons: $HEADLESS_RESTART_ELECTRONS"
