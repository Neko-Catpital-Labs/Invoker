#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d -t invoker-headless-extdeps-repro.XXXXXX)"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
PLAN_PATH="$TMP_DIR/external-deps-plan.yaml"
CONFIG_PATH="$TMP_DIR/config.json"
CRASH_DIR="$TMP_DIR/crashes"
STDOUT_LOG="$TMP_DIR/stdout.log"
STDERR_LOG="$TMP_DIR/stderr.log"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$DB_DIR" "$CRASH_DIR"

cd "$ROOT_DIR"

if [[ ! -f packages/app/dist/headless-client.js \
  || ! -f packages/app/dist/main.js \
  || packages/app/src/headless-client.ts -nt packages/app/dist/headless-client.js \
  || packages/app/src/headless-run-resume.ts -nt packages/app/dist/main.js ]]; then
  pnpm --filter @invoker/app build >/dev/null
fi

cat > "$CONFIG_PATH" <<'JSON'
{
  "autoFixRetries": 0,
  "maxConcurrency": 1
}
JSON

cat > "$PLAN_PATH" <<'YAML'
name: "Headless external deps segfault repro"
onFinish: none
scratch: true
externalDependencies:
  - workflowId: "wf-1786581036099-164"
    taskId: "__merge__"
    requiredStatus: completed
    gatePolicy: review_ready
tasks:
  - id: repro
    description: "Minimal external dependency repro task"
    prompt: "Say hello."
YAML

set +e
env \
  HOME="$HOME_DIR" \
  INVOKER_DB_DIR="$DB_DIR" \
  INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH" \
  INVOKER_HEADLESS_STANDALONE=1 \
  ELECTRON_ENABLE_LOGGING=1 \
  ELECTRON_CRASH_REPORTS_DIR="$CRASH_DIR" \
  timeout -k 5 30 node ./packages/app/dist/headless-client.js run "$PLAN_PATH" --no-track \
    >"$STDOUT_LOG" 2>"$STDERR_LOG"
STATUS=$?
set -e

if [[ "$STATUS" -eq 124 ]]; then
  echo "FAIL: headless run timed out" >&2
  cat "$STDERR_LOG" >&2 || true
  exit 1
fi

if [[ "$STATUS" -ge 128 ]]; then
  SIGNAL=$((STATUS - 128))
  echo "FAIL: headless run exited from signal $SIGNAL (status $STATUS)" >&2
  cat "$STDERR_LOG" >&2 || true
  find "$CRASH_DIR" -maxdepth 3 -type f -print >&2 || true
  exit 1
fi

if [[ "$STATUS" -eq 0 ]]; then
  if ! grep -Eq 'Workflow ID:|Delegated to owner|submission accepted' "$STDOUT_LOG"; then
    echo "FAIL: headless run exited 0 without a submission marker" >&2
    cat "$STDOUT_LOG" >&2 || true
    cat "$STDERR_LOG" >&2 || true
    exit 1
  fi
  echo "PASS: externalDependencies plan submitted through built headless client without a crash"
  exit 0
fi

if grep -Fq 'Plan submission blocked due to missing cross-workflow prerequisites' "$STDERR_LOG"; then
  echo "PASS: externalDependencies plan failed loudly with missing-prerequisite validation instead of crashing"
  exit 0
fi

echo "FAIL: headless run exited $STATUS without the expected actionable validation error" >&2
cat "$STDOUT_LOG" >&2 || true
cat "$STDERR_LOG" >&2 || true
exit 1
