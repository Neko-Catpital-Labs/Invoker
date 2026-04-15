#!/usr/bin/env bash
# Group 2.14 — standalone rebase-retry must not timeout-kill owner and strand tasks as running.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

CFG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-config.XXXXXX.json")"
printf '{}\n' > "$CFG_FILE"
export INVOKER_REPO_CONFIG_PATH="$CFG_FILE"
trap 'rm -f "$CFG_FILE"; invoker_e2e_cleanup' EXIT

echo "==> case 2.14: delete-all"
invoker_e2e_run_headless delete-all

PLAN="$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group2-multi-task/2.14-standalone-timeout-deadlock.yaml"
echo "==> case 2.14: submit plan (expect fail after ~3s)"
invoker_e2e_submit_plan "$PLAN" || true

STA="$(invoker_e2e_task_status e2e-g2214-taskA)"
if [ "$STA" != "failed" ]; then
  echo "FAIL case 2.14: expected taskA=failed, got '$STA'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "==> case 2.14: run rebase-retry-all with --timeout 1 in standalone mode"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-214.XXXXXX.log")"
START_SEC="$(date +%s)"
set +e
INVOKER_HEADLESS_STANDALONE=1 bash "$INVOKER_E2E_REPO_ROOT/scripts/rebase-retry-all.sh" \
  --parallel 4 --timeout 1 >"$OUT_FILE" 2>&1
CODE=$?
set -e
ELAPSED="$(( $(date +%s) - START_SEC ))"

if [ "$CODE" -ne 0 ]; then
  echo "FAIL case 2.14: rebase-retry-all exited $CODE"
  sed -n '1,160p' "$OUT_FILE" || true
  exit 1
fi

if ! rg -q 'Processing workflow:' "$OUT_FILE"; then
  echo "FAIL case 2.14: expected at least one workflow to be processed"
  sed -n '1,160p' "$OUT_FILE" || true
  exit 1
fi

if ! rg -q 'standalone mode detected, forcing --parallel 1' "$OUT_FILE"; then
  echo "FAIL case 2.14: expected standalone parallelism guard log"
  sed -n '1,160p' "$OUT_FILE" || true
  exit 1
fi

if ! rg -q 'standalone mode detected, disabling per-command timeout' "$OUT_FILE"; then
  echo "FAIL case 2.14: expected standalone timeout guard log"
  sed -n '1,160p' "$OUT_FILE" || true
  exit 1
fi

if [ "$ELAPSED" -lt 2 ]; then
  echo "FAIL case 2.14: expected guarded run to exceed 1s timeout (elapsed=${ELAPSED}s)"
  sed -n '1,160p' "$OUT_FILE" || true
  exit 1
fi

STALE_RUNNING="$(
  invoker_e2e_run_headless query tasks --output jsonl \
    | grep '^{' \
    | jq -r '
      select(.status=="running")
      | ((.execution.lastHeartbeatAt // .execution.startedAt // "1970-01-01T00:00:00Z")
          | sub("\\.[0-9]+Z$"; "Z")
          | fromdateiso8601) as $hb
      | select((now - $hb) > 15)
      | .id
    '
)"
if [ -n "$STALE_RUNNING" ]; then
  echo "FAIL case 2.14: found stale running task(s) after guarded rebase-retry-all"
  echo "$STALE_RUNNING"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 2.14 (standalone timeout guard prevents orphaned running-task deadlock)"
