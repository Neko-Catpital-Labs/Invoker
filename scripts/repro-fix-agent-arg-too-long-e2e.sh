#!/usr/bin/env bash
set -euo pipefail

EXPECT_MODE="${1:-fail}"  # fail | pass
if [[ "$EXPECT_MODE" != "fail" && "$EXPECT_MODE" != "pass" ]]; then
  echo "Usage: $0 [fail|pass]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/e2e-dry-run/lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

# Deterministic codex stub: fail with exit 126 when argv size exceeds threshold.
rm -f "$INVOKER_E2E_STUB_DIR/codex"
cat > "$INVOKER_E2E_STUB_DIR/codex" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
MAX_BYTES="${INVOKER_E2E_ARG_MAX_BYTES:-60000}"
TOTAL=0
SESSION_ID=""
while [[ "$#" -gt 0 ]]; do
  arg="$1"
  TOTAL=$((TOTAL + ${#arg}))
  if [[ "$arg" == "--session-id" && "$#" -ge 2 ]]; then
    SESSION_ID="$2"
    TOTAL=$((TOTAL + ${#2}))
    shift 2
    continue
  fi
  shift
 done

if [[ "$TOTAL" -gt "$MAX_BYTES" ]]; then
  echo "bash: line 5: /usr/bin/codex: Argument list too long" >&2
  exit 126
fi

if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="e2e-codex-$RANDOM-$RANDOM"
fi

ROOT="${INVOKER_E2E_MARKER_ROOT:-}"
if [[ -n "$ROOT" ]]; then
  mkdir -p "$ROOT"
  echo ok > "$ROOT/codex-ok-$(date +%s)-$$.marker"
fi

TS_ISO=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '%s\n' "{\"type\":\"thread.started\",\"thread_id\":\"${SESSION_ID}\"}"
printf '%s\n' "{\"timestamp\":\"${TS_ISO}\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}"
exit 0
STUB
chmod +x "$INVOKER_E2E_STUB_DIR/codex"

PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-arg-too-long.XXXXXX.yaml")"
cat > "$PLAN_FILE" <<'YAML'
name: "e2e repro - fix agent argument too long"
repoUrl: git@github.com:EdbertChan/Invoker.git
onFinish: none
baseBranch: HEAD

tasks:
  - id: e2e-arg-too-long-task
    description: "Emit huge output then fail; fix prompt becomes very large"
    command: "for i in $(seq 1 220); do head -c 12000 /dev/zero | tr '\\0' 'A'; echo; done; exit 1"
    dependencies: []
YAML

echo "==> repro(arg-too-long): delete-all"
invoker_e2e_run_headless delete-all

echo "==> repro(arg-too-long): submit plan"
invoker_e2e_submit_plan "$PLAN_FILE" || true
invoker_e2e_wait_settled e2e-arg-too-long-task

ST=$(invoker_e2e_task_status e2e-arg-too-long-task)
if [[ "$ST" != "failed" ]]; then
  echo "FAIL repro: expected initial status=failed, got '$ST'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "==> repro(arg-too-long): run fix with codex (expect=$EXPECT_MODE)"
FIX_OUT="$(invoker_e2e_run_headless fix e2e-arg-too-long-task codex 2>&1 || true)"
sleep 1
invoker_e2e_wait_settled e2e-arg-too-long-task || true

DETAILS="$(invoker_e2e_run_headless query task e2e-arg-too-long-task 2>&1 || true)"
ST_AFTER=$(invoker_e2e_task_status e2e-arg-too-long-task)

if [[ "$EXPECT_MODE" == "fail" ]]; then
  if [[ "$ST_AFTER" != "failed" ]]; then
    echo "FAIL repro(before): expected status=failed after fix attempt, got '$ST_AFTER'"
    invoker_e2e_run_headless status 2>&1 || true
    exit 1
  fi
  if ! grep -Eq "spawn E2BIG|Argument list too long" <<<"$FIX_OUT"; then
    echo "FAIL repro: expected spawn/argv-too-long failure in fix output"
    echo "--- fix output ---"
    echo "$FIX_OUT"
    echo "--------------------"
    exit 1
  fi
  echo "PASS repro(before): fix failed with expected 'Argument list too long'"
  exit 0
fi

# expect pass
if [[ "$ST_AFTER" != "awaiting_approval" ]]; then
  echo "FAIL repro(after): expected status=awaiting_approval after fix, got '$ST_AFTER'"
  echo "--- fix output ---"
  echo "$FIX_OUT"
  echo "--------------------"
  echo "--- task details ---"
  echo "$DETAILS"
  echo "--------------------"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS repro(after): oversized prompt no longer breaks fix path (task reached awaiting_approval)"
