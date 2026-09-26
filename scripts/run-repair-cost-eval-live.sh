#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ "${INVOKER_REPAIR_COST_EVAL_LIVE:-0}" != "1" ]; then
  echo "NOOP: set INVOKER_REPAIR_COST_EVAL_LIVE=1 to run the repair-cost live canary"
  exit 0
fi

N="${INVOKER_REPAIR_COST_EVAL_N:-5}"
MODEL="${INVOKER_REPAIR_COST_EVAL_MODEL:-gpt-5.4}"
STATUS_BAND_FACTOR="$(node -e 'import("./scripts/repair-cost-eval.mjs").then(m => console.log(m.STATUS_BAND_FACTOR))')"
RESULTS_DIR="$ROOT/evals/repair-cost/results"
TINY_REPO="$ROOT/evals/repair-cost/fixtures/tiny-repo"
MARKER_PREFIX="repair-cost-eval-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RESULTS_DIR" "$TINY_REPO"

if [ ! -f "$TINY_REPO/README" ]; then
  printf '%s\n' 'Tiny fixture cwd for repair-cost live canary.' > "$TINY_REPO/README"
fi

node scripts/repair-cost-eval.mjs --self-test >/dev/null

if ! command -v codex >/dev/null 2>&1; then
  echo "error: codex CLI not found on PATH" >&2
  exit 1
fi

median_of() {
  python3 -c '
import statistics, sys
vals = [float(x) for x in sys.argv[1:]]
print(statistics.median(vals) if vals else "nan")
' "$@"
}

extract_tokens_from_rollout() {
  local path="$1"
  python3 -c '
import json, sys
path = sys.argv[1]
total = None
with open(path) as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        payload = e.get("payload") if isinstance(e, dict) else None
        if not isinstance(payload, dict):
            continue
        if payload.get("type") == "token_count":
            info = payload.get("info") or {}
            tu = info.get("total_token_usage") or {}
            if isinstance(tu.get("total_tokens"), (int, float)):
                total = int(tu["total_tokens"])
print(total if total is not None else "")
' "$path"
}

find_rollout_with_marker() {
  local marker="$1"
  local sessions_root="${CODEX_HOME:-$HOME/.codex}/sessions"
  python3 -c '
import os, sys
from pathlib import Path
marker = sys.argv[1].encode()
root = Path(os.path.expanduser(sys.argv[2]))
hits = []
if root.is_dir():
    for path in root.rglob("rollout-*.jsonl"):
        try:
            if marker in path.read_bytes()[:4_000_000]:
                hits.append(path)
        except OSError:
            continue
hits.sort(key=lambda p: p.stat().st_mtime, reverse=True)
print(str(hits[0]) if hits else "")
' "$marker" "$sessions_root"
}

build_split_prompt() {
  local class="$1"
  local marker="$2"
  local status
  status="$(bash evals/repair-cost/status.sh "$class")"
  cat <<EOF
MARKER=${marker}
Repair the ${class} failure in this tiny fixture repo.
Poll status only via: bash ${ROOT}/evals/repair-cost/status.sh ${class}
Do not read raw logs, gh output, or verify-command transcripts.
Current status:
${status}
Reply with one short sentence confirming the status line, then stop. Do not run long verify commands.
EOF
}

build_combined_status_prompt() {
  local marker="$1"
  local s1 s2
  s1="$(bash evals/repair-cost/status.sh merge-conflict)"
  s2="$(bash evals/repair-cost/status.sh test-failure)"
  cat <<EOF
MARKER=${marker}
Coordinate these failure classes. Each class keeps its own claim and agent.
Poll status only via: bash ${ROOT}/evals/repair-cost/status.sh <merge-conflict|test-failure>
Do not read raw logs, gh output, or verify-command transcripts.
Statuses:
${s1}
${s2}
Reply with one short sentence confirming both status lines, then stop. Do not run long verify commands.
EOF
}

run_arm() {
  local arm="$1"
  local rep="$2"
  local prompt="$3"
  local marker="${MARKER_PREFIX}-${arm}-r${rep}"
  local prompt_file
  prompt_file="$(mktemp)"
  printf '%s\n' "$prompt" > "$prompt_file"

  echo "[repair-cost-live] arm=${arm} rep=${rep} marker=${marker}" >&2
  (
    cd "$TINY_REPO"
    codex exec --json --model "$MODEL" "$(cat "$prompt_file")"
  ) >"$RESULTS_DIR/${arm}-r${rep}.stdout.jsonl" 2>"$RESULTS_DIR/${arm}-r${rep}.stderr.log" || {
    local rc=$?
    rm -f "$prompt_file"
    echo "error: codex failed for ${arm} r${rep} (exit ${rc}); see ${RESULTS_DIR}/${arm}-r${rep}.stderr.log" >&2
    exit "$rc"
  }
  rm -f "$prompt_file"

  local rollout tokens
  rollout="$(find_rollout_with_marker "$marker")"
  if [ -z "$rollout" ]; then
    echo "error: no rollout found containing marker ${marker}" >&2
    exit 1
  fi
  tokens="$(extract_tokens_from_rollout "$rollout")"
  if [ -z "$tokens" ]; then
    echo "error: no total_tokens in ${rollout}" >&2
    exit 1
  fi

  printf '%s\n' "{\"arm\":\"${arm}\",\"rep\":${rep},\"marker\":\"${marker}\",\"rollout\":\"${rollout}\",\"total_tokens\":${tokens},\"model\":\"${MODEL}\"}" \
    >>"$RESULTS_DIR/live-canary.jsonl"
  echo "$tokens"
}

SPLIT_TOKENS=()
for i in $(seq 1 "$N"); do
  prompt="$(build_split_prompt merge-conflict "${MARKER_PREFIX}-split-r${i}")"
  t="$(run_arm split "$i" "$prompt")"
  SPLIT_TOKENS+=("$t")
  if [ "${#SPLIT_TOKENS[@]}" -ge 1 ]; then
    split_med="$(median_of "${SPLIT_TOKENS[@]}")"
    python3 -c '
import sys
tok=float(sys.argv[1]); med=float(sys.argv[2]); factor=float(sys.argv[3])
if tok > med * factor:
    raise SystemExit(f"abort: split session {tok} exceeds measured split median {med} by factor {factor}")
' "$t" "$split_med" "$STATUS_BAND_FACTOR"
  fi
done

SPLIT_MEDIAN="$(median_of "${SPLIT_TOKENS[@]}")"
echo "[repair-cost-live] split median inclusive tokens=${SPLIT_MEDIAN} (n=${#SPLIT_TOKENS[@]})" >&2

COMBINED_TOKENS=()
for i in $(seq 1 "$N"); do
  prompt="$(build_combined_status_prompt "${MARKER_PREFIX}-combined-status-r${i}")"
  t="$(run_arm combined-status "$i" "$prompt")"
  COMBINED_TOKENS+=("$t")
  python3 -c '
import sys
tok=float(sys.argv[1]); med=float(sys.argv[2]); factor=float(sys.argv[3])
if tok > med * factor:
    raise SystemExit(f"abort: combined-status session {tok} exceeds split median {med} by factor {factor}")
' "$t" "$SPLIT_MEDIAN" "$STATUS_BAND_FACTOR"
done

COMBINED_MEDIAN="$(median_of "${COMBINED_TOKENS[@]}")"
echo "[repair-cost-live] combined-status median inclusive tokens=${COMBINED_MEDIAN} (n=${#COMBINED_TOKENS[@]})" >&2

python3 -c '
import json, statistics, sys
from pathlib import Path
split = [float(x) for x in sys.argv[1].split(",")]
combined = [float(x) for x in sys.argv[2].split(",")]
factor = float(sys.argv[3])
out = Path(sys.argv[4])
split_med = statistics.median(split)
combined_med = statistics.median(combined)
band_ok = combined_med <= split_med * factor
report = {
  "split_n": len(split),
  "combined_status_n": len(combined),
  "split_tokens": split,
  "combined_status_tokens": combined,
  "split_median": split_med,
  "combined_status_median": combined_med,
  "split_mean": statistics.mean(split),
  "combined_status_mean": statistics.mean(combined),
  "status_band_factor": factor,
  "pass": band_ok,
  "gate": "combined_status_median <= split_median * status_band_factor",
}
out.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
if not band_ok:
    raise SystemExit(
        f"FAIL: combined-status median {combined_med} exceeds split median {split_med} * {factor}"
    )
print("PASS: combined-status median stays within the split-arm status band")
' "$(IFS=,; echo "${SPLIT_TOKENS[*]}")" "$(IFS=,; echo "${COMBINED_TOKENS[*]}")" "$STATUS_BAND_FACTOR" "$RESULTS_DIR/aggregate.json"
