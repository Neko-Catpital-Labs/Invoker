#!/usr/bin/env bash
set -euo pipefail

BATCH_ID=""
RUN_ID=""
CONVERSATION_FILE=""
MODEL=""
MODE=""
INVOKER_SHA=""

usage() {
  cat <<'EOF'
Usage: run-worker-job.sh --batch-id ID --run-id ID --conversation-file PATH --model codex|claude --mode MODE --invoker-sha SHA
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --batch-id) BATCH_ID="${2:-}"; shift 2 ;;
    --run-id) RUN_ID="${2:-}"; shift 2 ;;
    --conversation-file) CONVERSATION_FILE="${2:-}"; shift 2 ;;
    --model) MODEL="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --invoker-sha) INVOKER_SHA="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

[[ -n "$BATCH_ID" ]] || die "Missing --batch-id"
[[ -n "$RUN_ID" ]] || die "Missing --run-id"
[[ -n "$CONVERSATION_FILE" ]] || die "Missing --conversation-file"
[[ -n "$MODEL" ]] || die "Missing --model"
[[ -n "$MODE" ]] || die "Missing --mode"
[[ -n "$INVOKER_SHA" ]] || die "Missing --invoker-sha"

BENCHMARK_ROOT="${BENCHMARK_ROOT:-/home/invoker/invoker-benchmarks}"
ENV_FILE="${BENCHMARK_ENV_FILE:-$BENCHMARK_ROOT/config/benchmark.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$ENV_FILE"
  set +a
fi

export TZ="${TZ:-Asia/Hong_Kong}"
JOB_DIR="$BENCHMARK_ROOT/runs/$BATCH_ID/jobs/$RUN_ID"
CHECKOUT_DIR="$JOB_DIR/checkout"
RAW_SESSIONS_DIR="$JOB_DIR/raw-sessions"
GENERATED_PLAN="$JOB_DIR/generated-plan.yaml"
STDOUT_LOG="$JOB_DIR/stdout.log"
STDERR_LOG="$JOB_DIR/stderr.log"
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

mkdir -p "$JOB_DIR" "$RAW_SESSIONS_DIR"
exec > >(tee -a "$STDOUT_LOG") 2> >(tee -a "$STDERR_LOG" >&2)

write_job_json() {
  local status="$1"
  local exit_code="${2:-0}"
  python3 - "$JOB_DIR/job.json" "$BATCH_ID" "$RUN_ID" "$CONVERSATION_FILE" "$MODEL" "$MODE" "$INVOKER_SHA" "$STARTED_AT" "$status" "$exit_code" <<'PY'
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

path, batch_id, run_id, conv, model, mode, sha, started, status, exit_code = sys.argv[1:]
job_dir = Path(path).parent
checkout = job_dir / "checkout"

def run_git(args):
    try:
        return subprocess.check_output(["git", "-C", str(checkout), *args], text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return ""

commits = []
log = run_git(["log", "--oneline", f"{sha}..HEAD"])
if log:
    commits = log.splitlines()
changed = run_git(["status", "--short"])
payload = {
    "batch_id": batch_id,
    "run_id": run_id,
    "conversation_file": conv,
    "conversation_id": Path(conv).stem,
    "model": model,
    "mode": mode,
    "invoker_sha": sha,
    "started_at": started,
    "finished_at": datetime.now(timezone.utc).isoformat(),
    "status": status,
    "exit_code": int(exit_code),
    "commits": commits,
    "changed_files": [line[3:] if len(line) > 3 else line for line in changed.splitlines()],
    "artifacts": {
        "stdout": "stdout.log",
        "stderr": "stderr.log",
        "generated_plan": "generated-plan.yaml",
        "invoker_events": "invoker-events.jsonl",
        "token_usage": "token-usage.json",
        "raw_sessions": "raw-sessions",
        "checkout": "checkout",
    },
}
Path(path).write_text(json.dumps(payload, indent=2, sort_keys=True))
PY
}

on_exit() {
  local code=$?
  if [[ "$code" -ne 0 && ! -f "$JOB_DIR/job.json" ]]; then
    write_job_json failed "$code" || true
  fi
}
trap on_exit EXIT

snapshot_session_dirs() {
  find "$HOME/.codex/sessions" "$HOME/.claude" -type f 2>/dev/null | sort > "$JOB_DIR/session-files-before.txt" || true
}

collect_new_sessions() {
  find "$HOME/.codex/sessions" "$HOME/.claude" -type f 2>/dev/null | sort > "$JOB_DIR/session-files-after.txt" || true
  comm -13 "$JOB_DIR/session-files-before.txt" "$JOB_DIR/session-files-after.txt" > "$JOB_DIR/session-files-new.txt" || true
  while IFS= read -r file; do
    [[ -f "$file" ]] || continue
    rel="${file#$HOME/}"
    mkdir -p "$RAW_SESSIONS_DIR/$(dirname "$rel")"
    cp "$file" "$RAW_SESSIONS_DIR/$rel" || true
  done < "$JOB_DIR/session-files-new.txt"
}

clear_non_credential_state() {
  rm -rf \
    "$HOME/.cache/codex" \
    "$HOME/.cache/claude" \
    "$HOME/.codex/benchmark-scratch" \
    "$HOME/.claude/benchmark-scratch" \
    "$HOME/.invoker/benchmark-scratch" \
    /tmp/invoker-benchmark-* 2>/dev/null || true
}

install_checkout() {
  rm -rf "$CHECKOUT_DIR"
  git clone --no-checkout "${INVOKER_REPO:-https://github.com/Neko-Catpital-Labs/Invoker.git}" "$CHECKOUT_DIR"
  git -C "$CHECKOUT_DIR" checkout "$INVOKER_SHA"
  (
    cd "$CHECKOUT_DIR"
    if [[ -f pnpm-lock.yaml ]]; then
      corepack enable >/dev/null 2>&1 || true
      pnpm install --frozen-lockfile
      pnpm run build --if-present
    elif [[ -f package-lock.json ]]; then
      npm ci
      npm run build --if-present
    elif [[ -f yarn.lock ]]; then
      yarn install --frozen-lockfile
      yarn build || true
    fi
  )
}

run_template() {
  local template="$1"
  if [[ -z "$template" ]]; then
    return 1
  fi
  (
    cd "$CHECKOUT_DIR"
    export CHECKOUT_DIR CONVERSATION_FILE MODEL MODE JOB_DIR GENERATED_PLAN INVOKER_SHA
    eval "$template"
  )
}

default_baseline() {
  (
    cd "$CHECKOUT_DIR"
    case "$MODEL" in
      codex)
        command -v codex >/dev/null || die "codex CLI not found and BENCHMARK_BASELINE_CODEX_COMMAND is unset"
        codex exec --skip-git-repo-check "$(cat "$CONVERSATION_FILE")"
        ;;
      claude)
        command -v claude >/dev/null || die "claude CLI not found and BENCHMARK_BASELINE_CLAUDE_COMMAND is unset"
        claude -p "$(cat "$CONVERSATION_FILE")"
        ;;
      *) die "Unsupported model: $MODEL" ;;
    esac
  )
}

default_plan() {
  case "$MODEL" in
    codex)
      if ! run_template "${BENCHMARK_PLAN_CODEX_COMMAND:-}"; then
        command -v codex >/dev/null || die "codex CLI not found and BENCHMARK_PLAN_CODEX_COMMAND is unset"
        (cd "$CHECKOUT_DIR" && codex exec --skip-git-repo-check "/plan-to-invoker\n$(cat "$CONVERSATION_FILE")") > "$GENERATED_PLAN"
      fi
      ;;
    claude)
      if ! run_template "${BENCHMARK_PLAN_CLAUDE_COMMAND:-}"; then
        command -v claude >/dev/null || die "claude CLI not found and BENCHMARK_PLAN_CLAUDE_COMMAND is unset"
        (cd "$CHECKOUT_DIR" && claude -p "/plan-to-invoker\n$(cat "$CONVERSATION_FILE")") > "$GENERATED_PLAN"
      fi
      ;;
    *) die "Unsupported model: $MODEL" ;;
  esac
}

default_invoker_submit() {
  (
    cd "$CHECKOUT_DIR"
    export INVOKER_AUTOFIX="$1"
    if run_template "${BENCHMARK_INVOKER_SUBMIT_COMMAND:-}"; then
      return 0
    fi
    if command -v invoker >/dev/null; then
      invoker workflow submit "$GENERATED_PLAN" --model "$MODEL" --no-pr --no-autostart --stop-at review_ready ${INVOKER_AUTOFIX:+--autofix}
    elif [[ -x ./bin/invoker ]]; then
      ./bin/invoker workflow submit "$GENERATED_PLAN" --model "$MODEL" --no-pr --no-autostart --stop-at review_ready ${INVOKER_AUTOFIX:+--autofix}
    else
      die "Invoker CLI not found and BENCHMARK_INVOKER_SUBMIT_COMMAND is unset"
    fi
  )
}

extract_token_usage() {
  python3 - "$RAW_SESSIONS_DIR" "$JOB_DIR/token-usage.json" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
out = Path(sys.argv[2])
totals = {
    "input_tokens": 0,
    "cache_read_tokens": 0,
    "cache_creation_tokens": 0,
    "output_tokens": 0,
    "reasoning_tokens": 0,
    "total_tokens": 0,
    "estimated_cost_usd": 0.0,
}

def add_usage(obj):
    usage = obj.get("usage") if isinstance(obj, dict) else None
    if not isinstance(usage, dict):
        usage = obj if isinstance(obj, dict) else {}
    mapping = {
        "input_tokens": ["input_tokens", "inputTokens"],
        "cache_read_tokens": ["cache_read_input_tokens", "cacheReadInputTokens", "cached_input_tokens", "cachedInputTokens"],
        "cache_creation_tokens": ["cache_creation_input_tokens", "cacheCreationInputTokens"],
        "output_tokens": ["output_tokens", "outputTokens"],
        "reasoning_tokens": ["reasoning_tokens", "reasoningTokens"],
        "total_tokens": ["total_tokens", "totalTokens"],
        "estimated_cost_usd": ["estimated_cost_usd", "costUSD", "totalCost"],
    }
    for dest, keys in mapping.items():
        for key in keys:
            value = usage.get(key)
            if isinstance(value, (int, float)):
                totals[dest] += value
                break

for path in root.rglob("*"):
    if not path.is_file():
        continue
    try:
        lines = path.read_text(errors="ignore").splitlines()
    except Exception:
        continue
    for line in lines:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            add_usage(json.loads(line))
        except Exception:
            pass

if not totals["total_tokens"]:
    totals["total_tokens"] = totals["input_tokens"] + totals["cache_read_tokens"] + totals["cache_creation_tokens"] + totals["output_tokens"] + totals["reasoning_tokens"]
totals["fresh_input_tokens"] = totals["input_tokens"] + totals["cache_creation_tokens"]
totals["normalized_total_tokens"] = totals["fresh_input_tokens"] + totals["output_tokens"] + totals["reasoning_tokens"]
out.write_text(json.dumps(totals, indent=2, sort_keys=True))
PY
}

echo "START run_id=$RUN_ID model=$MODEL mode=$MODE sha=$INVOKER_SHA"
snapshot_session_dirs
clear_non_credential_state
install_checkout

status="succeeded"
case "$MODE" in
  baseline_direct)
    baseline_var="BENCHMARK_BASELINE_${MODEL^^}_COMMAND"
    if ! run_template "${!baseline_var:-}"; then
      default_baseline
    fi
    ;;
  invoker_workflow)
    default_plan
    default_invoker_submit ""
    status="review_ready"
    ;;
  invoker_auto_fix)
    default_plan
    default_invoker_submit "1"
    status="review_ready"
    ;;
  *) die "Unsupported mode: $MODE" ;;
esac

collect_new_sessions
extract_token_usage
touch "$JOB_DIR/invoker-events.jsonl"
write_job_json "$status" 0
echo "END run_id=$RUN_ID status=$status"
