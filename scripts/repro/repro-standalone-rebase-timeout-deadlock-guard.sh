#!/usr/bin/env bash
# Repro/verification: standalone rebase-retry-all ignores per-command timeout
# to avoid timeout-killing the owner and leaving tasks stuck in running.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../e2e-dry-run/lib/common.sh"

invoker_e2e_init
cleanup() {
  rm -rf "${CFG_FILE:-}" "${OUT_FILE:-}" 2>/dev/null || true
  invoker_e2e_cleanup
}
trap cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

CFG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-config.XXXXXX.json")"
printf '{}\n' > "$CFG_FILE"
export INVOKER_REPO_CONFIG_PATH="$CFG_FILE"

echo "==> repro: delete-all"
invoker_e2e_run_headless delete-all

PLAN="$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group2-multi-task/2.14-standalone-timeout-deadlock.yaml"
echo "==> repro: submit plan $PLAN (taskA fails after ~3s)"
invoker_e2e_submit_plan "$PLAN" || true

echo "==> repro: run standalone rebase-retry-all with --timeout 1"
OUT_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-standalone-timeout.XXXXXX.log")"
START_SEC="$(date +%s)"
INVOKER_HEADLESS_STANDALONE=1 bash "$INVOKER_E2E_REPO_ROOT/scripts/rebase-retry-all.sh" \
  --parallel 4 --timeout 1 2>&1 | tee "$OUT_FILE"
ELAPSED="$(( $(date +%s) - START_SEC ))"
echo "elapsed: ${ELAPSED}s"

echo "==> expected guard lines"
rg -n 'standalone mode detected, forcing --parallel 1|standalone mode detected, disabling per-command timeout' "$OUT_FILE" || true

echo "==> stale running tasks (>15s heartbeat age)"
invoker_e2e_run_headless query tasks --output jsonl \
  | grep '^{' \
  | jq -r '
      select(.status=="running")
      | ((.execution.lastHeartbeatAt // .execution.startedAt // "1970-01-01T00:00:00Z")
          | sub("\\.[0-9]+Z$"; "Z")
          | fromdateiso8601) as $hb
      | select((now - $hb) > 15)
      | .id
    ' || true

echo "repro complete"
