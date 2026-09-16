#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bash scripts/run-fix-ci-token-bench-live.sh

Opt-in live canary for the fix-ci token budget. Inert by default: it runs one
real `codex exec --json` session against
scripts/fixtures/fix-ci-token-bench/tiny-failing-repo (copied to a scratch
directory first, never edited in place), reads the resulting real rollout file
back through scripts/codex-session-audit.py, and fails when that session's
total_tokens is at or above the ceiling.

This spends real Codex API tokens, so it never runs from `pnpm test`, nightly
tooling, or any CI job. It is registered in
scripts/test-suites/regression-inventory.yaml as tier `manual`.

Environment:
  INVOKER_FIX_CI_TOKEN_BUDGET_LIVE=1       required; without it this exits 0
                                           immediately and starts no process
  INVOKER_FIX_CI_TOKEN_BUDGET_CEILING      max total_tokens, exclusive
                                           (default: 300000)
  INVOKER_FIX_CI_TOKEN_BUDGET_CODEX_BIN    codex binary (default: codex)
  INVOKER_FIX_CI_TOKEN_BUDGET_SESSIONS_ROOT
                                           rollout root
                                           (default: ~/.codex/sessions)

Appends one JSON line per run to
scripts/fixtures/fix-ci-token-bench/results/live-canary.jsonl.
USAGE
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "${INVOKER_FIX_CI_TOKEN_BUDGET_LIVE:-0}" != "1" ]; then
  echo "NOOP: set INVOKER_FIX_CI_TOKEN_BUDGET_LIVE=1 to run this canary" && exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BENCH_DIR="$REPO_ROOT/scripts/fixtures/fix-ci-token-bench"
FIXTURE_DIR="$BENCH_DIR/tiny-failing-repo"
AUDIT_SCRIPT="$REPO_ROOT/scripts/codex-session-audit.py"
RESULTS_DIR="$BENCH_DIR/results"
RESULTS_FILE="$RESULTS_DIR/live-canary.jsonl"

CEILING="${INVOKER_FIX_CI_TOKEN_BUDGET_CEILING:-300000}"
CODEX_BIN="${INVOKER_FIX_CI_TOKEN_BUDGET_CODEX_BIN:-codex}"
SESSIONS_ROOT="${INVOKER_FIX_CI_TOKEN_BUDGET_SESSIONS_ROOT:-$HOME/.codex/sessions}"
PROMPT="Run 'node verify.mjs' in this repository. It fails. Fix the bug in src/sum.mjs so the test passes, run 'node verify.mjs' once more to confirm, then stop."

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

case "$CEILING" in
  '' | *[!0-9]*) fail "INVOKER_FIX_CI_TOKEN_BUDGET_CEILING must be a positive integer, got '$CEILING'" ;;
esac

[ -d "$FIXTURE_DIR" ] || fail "missing fixture repo: $FIXTURE_DIR"
[ -f "$AUDIT_SCRIPT" ] || fail "missing audit script: $AUDIT_SCRIPT"
command -v python3 >/dev/null 2>&1 || fail "python3 is required to run $AUDIT_SCRIPT"
command -v "$CODEX_BIN" >/dev/null 2>&1 || fail "codex binary '$CODEX_BIN' is not on PATH"
[ -d "$SESSIONS_ROOT" ] || fail "codex sessions root not found: $SESSIONS_ROOT"

WORK_DIR="$(mktemp -d)"
AUDIT_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR" "$AUDIT_DIR"; }
trap cleanup EXIT

WORK_REPO="$WORK_DIR/repo"
mkdir -p "$WORK_REPO"
cp -R "$FIXTURE_DIR/." "$WORK_REPO/"
git -C "$WORK_REPO" init -q
git -C "$WORK_REPO" add -A
git -C "$WORK_REPO" -c user.email=canary@invoker.local -c user.name="fix-ci token canary" commit -q -m "fixture baseline"

STDOUT_LOG="$WORK_DIR/codex-exec.jsonl"
STDERR_LOG="$WORK_DIR/codex-exec.err"
START_MARKER="$WORK_DIR/start-marker"
touch "$START_MARKER"

echo "Running one live codex session against $WORK_REPO (ceiling: $CEILING tokens)."
set +e
( cd "$WORK_REPO" && "$CODEX_BIN" exec --json "$PROMPT" ) >"$STDOUT_LOG" 2>"$STDERR_LOG"
CODEX_STATUS=$?
set -e

SESSION_ID="$(python3 - "$STDOUT_LOG" <<'PY'
import json
import sys

session_id = ""
try:
    with open(sys.argv[1]) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("type") == "thread.started":
                session_id = row.get("thread_id") or ""
            elif row.get("type") == "session_meta":
                session_id = (row.get("payload") or {}).get("id") or ""
            if session_id:
                break
except OSError:
    pass
print(session_id)
PY
)"

ROLLOUT_PATH=""
if [ -n "$SESSION_ID" ]; then
  ROLLOUT_PATH="$(find "$SESSIONS_ROOT" -type f -name "rollout-*${SESSION_ID}*.jsonl" 2>/dev/null | head -n 1 || true)"
fi
if [ -z "$ROLLOUT_PATH" ]; then
  ROLLOUT_PATH="$(find "$SESSIONS_ROOT" -type f -name 'rollout-*.jsonl' -newer "$START_MARKER" 2>/dev/null | sort | tail -n 1 || true)"
fi
if [ -z "$ROLLOUT_PATH" ]; then
  if [ -s "$STDERR_LOG" ]; then
    sed -n '1,20p' "$STDERR_LOG" >&2
  fi
  fail "no codex rollout file for this run under $SESSIONS_ROOT (codex exited $CODEX_STATUS)"
fi

cp "$ROLLOUT_PATH" "$AUDIT_DIR/"
AUDIT_JSON="$(python3 "$AUDIT_SCRIPT" --session-dir "$AUDIT_DIR")"

AUDIT_FIELDS="$(python3 - "$AUDIT_JSON" <<'PY'
import json
import sys

rows = json.loads(sys.argv[1])
if len(rows) != 1:
    print(f"error\texpected exactly one audited session, got {len(rows)}")
    raise SystemExit(0)
row = rows[0]
total = row.get("total_tokens")
if total is None:
    print("error\tthe rollout file has no token_count event, so real spend is unprovable")
    raise SystemExit(0)
print("ok\t{}\t{}".format(int(total), row.get("model") or "unknown"))
PY
)"

IFS=$'\t' read -r AUDIT_STATUS AUDIT_A AUDIT_B <<<"$AUDIT_FIELDS"
if [ "$AUDIT_STATUS" != "ok" ]; then
  fail "$AUDIT_A (rollout: $ROLLOUT_PATH)"
fi
TOTAL_TOKENS="$AUDIT_A"
MODEL="$AUDIT_B"

if [ "$TOTAL_TOKENS" -ge "$CEILING" ]; then
  VERDICT="over-ceiling"
else
  VERDICT="ok"
fi

mkdir -p "$RESULTS_DIR"
python3 - "$RESULTS_FILE" "$VERDICT" "$TOTAL_TOKENS" "$CEILING" "$SESSION_ID" "$(basename "$ROLLOUT_PATH")" "$MODEL" "$CODEX_STATUS" <<'PY'
import datetime
import json
import sys

(results_file, verdict, total_tokens, ceiling, session_id, rollout_file, model, codex_status) = sys.argv[1:9]
record = {
    "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "script": "scripts/run-fix-ci-token-bench-live.sh",
    "verdict": verdict,
    "total_tokens": int(total_tokens),
    "ceiling": int(ceiling),
    "session_id": session_id,
    "rollout_file": rollout_file,
    "model": model,
    "codex_exit_status": int(codex_status),
}
with open(results_file, "a") as fh:
    fh.write(json.dumps(record, sort_keys=True) + "\n")
PY

echo "Recorded live canary run in $RESULTS_FILE"
echo "  rollout:      $ROLLOUT_PATH"
echo "  model:        $MODEL"
echo "  total_tokens: $TOTAL_TOKENS (ceiling: $CEILING)"

if [ "$VERDICT" = "over-ceiling" ]; then
  fail "live codex session spent $TOTAL_TOKENS tokens, at or above the ceiling of $CEILING"
fi

echo "PASS: live codex session spent $TOTAL_TOKENS tokens, under the ceiling of $CEILING."
