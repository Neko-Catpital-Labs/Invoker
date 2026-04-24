#!/usr/bin/env bash
# GUI owner active, headless reject must delegate cleanly and not hang.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$ROOT/scripts/e2e-dry-run/lib/common.sh"

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"
unset INVOKER_HEADLESS_STANDALONE
unset ELECTRON_RUN_AS_NODE

TMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/invoker-chaos-owner-reject-home.XXXXXX")"
export HOME="$TMP_HOME"
mkdir -p "$HOME/.invoker"
export INVOKER_DB_DIR="$HOME/.invoker"
export INVOKER_REPO_CONFIG_PATH="$(mktemp "${TMPDIR:-/tmp}/invoker-chaos-owner-reject-config.XXXXXX.json")"
printf '{\n  "autoFixRetries": 0\n}\n' > "$INVOKER_REPO_CONFIG_PATH"

OWNER_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-chaos-owner-reject-owner.XXXXXX.log")"
SUBMIT_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-chaos-owner-reject-submit.XXXXXX.log")"
PLAN_PATH="$(mktemp "${TMPDIR:-/tmp}/invoker-chaos-owner-reject-plan.XXXXXX.yaml")"
OWNER_PID=""

cleanup() {
  if [ -n "$OWNER_PID" ]; then
    kill "$OWNER_PID" 2>/dev/null || true
    wait "$OWNER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_HOME" 2>/dev/null || true
  rm -f "$INVOKER_REPO_CONFIG_PATH" "$OWNER_LOG" "$SUBMIT_LOG" "$PLAN_PATH" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> owner-reject: start GUI owner"
./run.sh >"$OWNER_LOG" 2>&1 &
OWNER_PID=$!

echo "==> owner-reject: wait for GUI owner readiness"
READY=0
for i in $(seq 1 240); do
  if [ -S "$HOME/.invoker/ipc-transport.sock" ]; then
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "FAIL owner-reject: owner never exposed ipc socket"
  cat "$OWNER_LOG"
  exit 1
fi

cat > "$PLAN_PATH" <<EOF
name: chaos owner delegated reject
repoUrl: $(python3 - <<'PY' "$ROOT"
import pathlib, sys
print(pathlib.Path(sys.argv[1]).resolve().as_uri())
PY
)
tasks:
  - id: manual-owner-reject
    description: Manual reject routed through GUI owner
    requiresManualApproval: true
    command: bash -lc 'exit 0'
EOF

echo "==> owner-reject: submit workflow via owner"
./submit-plan.sh "$PLAN_PATH" 2>&1 | tee "$SUBMIT_LOG"
WF_ID="$(python3 - <<'PY' "$SUBMIT_LOG"
import re, sys
text = open(sys.argv[1], encoding='utf-8', errors='ignore').read()
matches = re.findall(r'wf-\d+-\d+', text)
print(matches[-1] if matches else '')
PY
)"
if [ -z "$WF_ID" ]; then
  echo "FAIL owner-reject: could not resolve workflow id"
  cat "$SUBMIT_LOG"
  exit 1
fi

TASK_ID="$WF_ID/manual-owner-reject"
echo "==> owner-reject: wait for awaiting_approval"
invoker_e2e_wait_task_status "$TASK_ID" awaiting_approval 60

echo "==> owner-reject: delegated headless reject"
invoker_e2e_run_headless reject "$TASK_ID"
invoker_e2e_wait_task_status "$TASK_ID" failed 60
invoker_e2e_assert_liveness_clean 15 30 0

echo "PASS owner-reject-delegated ($TASK_ID failed via delegated reject)"
