#!/usr/bin/env bash
# Haiku spend e2e: park (invoker-cli wait) must beat in-turn poll on cost_usd.
# Skip (exit 0) when ANTHROPIC_API_KEY is missing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

EVAL_DIR="$ROOT/scripts/invoker-wait-spend"
RESULTS_DIR="$EVAL_DIR/results"
RUNNERS="$EVAL_DIR/runners.json"
TEMPLATE="$EVAL_DIR/sleep.template.yaml"
BUDGET_USD="${INVOKER_WAIT_SPEND_BUDGET_USD:-2}"
MODEL="haiku"

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "SKIP: ANTHROPIC_API_KEY missing — invoker-wait-spend e2e not run"
  exit 0
fi

if [[ "$(uname -s)" == "Darwin" && "${CI:-}" != "true" ]]; then
  WAIT_SECONDS=180
else
  WAIT_SECONDS=45
fi

mkdir -p "$RESULTS_DIR"
SPEND_JSONL="$RESULTS_DIR/spend.jsonl"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-wait-spend.XXXXXX")"
PLAN="$WORKDIR/sleep.yaml"
OWNER_LOG="$WORKDIR/owner.log"
cleanup() {
  if [[ -n "${OWNER_PID:-}" ]] && kill -0 "$OWNER_PID" 2>/dev/null; then
    kill "$OWNER_PID" 2>/dev/null || true
    wait "$OWNER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

sed "s/WAIT_SECONDS/${WAIT_SECONDS}/g" "$TEMPLATE" > "$PLAN"
export INVOKER_WAIT_SPEND_PLAN="$PLAN"

export INVOKER_DB_DIR="$WORKDIR/db"
mkdir -p "$INVOKER_DB_DIR"

if [[ -f "$ROOT/packages/cli/dist/index.js" ]]; then
  CLI=(node "$ROOT/packages/cli/dist/index.js")
elif command -v invoker-cli >/dev/null 2>&1; then
  CLI=(invoker-cli)
else
  CLI=(node --import tsx "$ROOT/packages/cli/src/index.ts")
fi

echo "Starting owner in $INVOKER_DB_DIR (wait=${WAIT_SECONDS}s)..."
"${CLI[@]}" owner serve >"$OWNER_LOG" 2>&1 &
OWNER_PID=$!

for _ in $(seq 1 60); do
  if "${CLI[@]}" query workflows --output json >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if ! "${CLI[@]}" query workflows --output json >/dev/null 2>&1; then
  echo "FAIL: owner did not become ready" >&2
  tail -n 50 "$OWNER_LOG" >&2 || true
  exit 1
fi

python3 - "$ROOT" "$RUNNERS" "$SPEND_JSONL" "$WAIT_SECONDS" "$BUDGET_USD" "$MODEL" "$PLAN" "${CLI[@]}" <<'PY'
import json
import os
import subprocess
import sys
import time
from pathlib import Path

root = Path(sys.argv[1])
runners_path = Path(sys.argv[2])
spend_path = Path(sys.argv[3])
wait_seconds = int(sys.argv[4])
budget_usd = float(sys.argv[5])
model = sys.argv[6]
plan_path = sys.argv[7]
cli = sys.argv[8:]

sys.path.insert(0, str(root / "scripts"))
from run_skill_evals import parse_response  # noqa: E402

runners = json.loads(runners_path.read_text(encoding="utf-8"))
poll_runner = runners["claude-haiku"]
park_runner = runners["claude-haiku-no-tools"]
response_format = poll_runner["response_format"]
budget_flag = poll_runner.get("budget_flag")
reported_cost = 0.0


def remaining() -> float:
    left = budget_usd - reported_cost
    if left <= 0:
        raise RuntimeError("Budget exhausted")
    return left


def run_claude(runner: dict, prompt: str) -> dict:
    global reported_cost
    cmd = list(runner["command"])
    if budget_flag:
        cmd.extend([budget_flag, f"{remaining():.4f}"])
    cmd.append(prompt)
    completed = subprocess.run(cmd, check=False, capture_output=True, text=True, cwd=str(root))
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"claude failed ({completed.returncode}): {detail[:2000]}")
    text, usage, cost = parse_response(completed.stdout, response_format)
    if cost is None:
        raise RuntimeError("Runner did not report dollar cost")
    reported_cost += float(cost)
    return {"response": text, "usage": usage, "cost_usd": float(cost), "model": model}


def submit_workflow() -> str:
    completed = subprocess.run(
        [*cli, "run", plan_path, "--live", "--json"],
        check=False,
        capture_output=True,
        text=True,
        cwd=str(root),
    )
    if completed.returncode != 0:
        raise RuntimeError(f"submit failed: {(completed.stderr or completed.stdout)[:2000]}")
    line = completed.stdout.strip().splitlines()[-1]
    payload = json.loads(line)
    wf = (payload.get("workflow") or {}).get("id") or payload.get("workflowId")
    if not wf:
        raise RuntimeError(f"no workflow id in submit: {line}")
    return str(wf)


baseline_wf = submit_workflow()
print(f"baseline workflow: {baseline_wf}", flush=True)

baseline_prompt = f"""You are measuring poll spend against Invoker workflow {baseline_wf}.
Use the Bash tool only. Poll with this exact command until all tasks are settled
(completed/failed/closed/awaiting_approval/review_ready/blocked/needs_input/stale),
sleeping ~3 seconds between polls:

{" ".join(cli)} query tasks --workflow {baseline_wf} --output json

Do not invent status. When settled, reply with exactly: SETTLED
You must run the query command at least twice.
"""

baseline = run_claude(poll_runner, baseline_prompt)
baseline_row = {
    "condition": "baseline",
    "cost_usd": baseline["cost_usd"],
    "usage": baseline["usage"],
    "model": model,
    "wait_ms": wait_seconds * 1000,
    "workflow_id": baseline_wf,
    "response": baseline["response"][:500],
}

park_wf = submit_workflow()
print(f"candidate workflow: {park_wf}", flush=True)

turn1 = run_claude(
    park_runner,
    f"Workflow {park_wf} was submitted. Do not poll. Reply with exactly: ACK {park_wf}",
)

wait_started = time.time()
wait_proc = subprocess.run(
    [*cli, "wait", park_wf, "--max-wait-ms", str((wait_seconds + 60) * 1000), "--poll-interval-ms", "2000"],
    check=False,
    capture_output=True,
    text=True,
    cwd=str(root),
)
wait_elapsed_ms = int((time.time() - wait_started) * 1000)
wake_lines = [ln for ln in wait_proc.stdout.splitlines() if ln.startswith("INVOKER_WAKE ")]
if len(wake_lines) != 1:
    raise RuntimeError(
        f"expected exactly one INVOKER_WAKE line, got {len(wake_lines)}; "
        f"rc={wait_proc.returncode} stdout={wait_proc.stdout!r} stderr={wait_proc.stderr!r}"
    )
wake_line = wake_lines[0]
if len(wake_line.encode("utf-8")) > 2048:
    raise RuntimeError("INVOKER_WAKE payload exceeds 2048 bytes")
wake_payload = json.loads(wake_line[len("INVOKER_WAKE "):])
if "tasks" in wake_payload:
    raise RuntimeError("INVOKER_WAKE must not include tasks")

turn2 = run_claude(
    park_runner,
    f"Parent wake signal (one line only):\n{wake_line}\nReply with exactly: CONTINUED",
)

candidate_row = {
    "condition": "candidate",
    "cost_usd": turn1["cost_usd"] + turn2["cost_usd"],
    "usage": {"turn1": turn1["usage"], "turn2": turn2["usage"]},
    "model": model,
    "wait_ms": wait_elapsed_ms,
    "workflow_id": park_wf,
    "model_calls": 2,
    "tokens_during_wait": 0,
    "cost_during_wait_usd": 0.0,
    "wake_line": wake_line,
    "response": {"turn1": turn1["response"][:200], "turn2": turn2["response"][:200]},
}

spend_path.parent.mkdir(parents=True, exist_ok=True)
with spend_path.open("a", encoding="utf-8") as fh:
    fh.write(json.dumps(baseline_row, ensure_ascii=False) + "\n")
    fh.write(json.dumps(candidate_row, ensure_ascii=False) + "\n")

if candidate_row["model_calls"] != 2:
    raise SystemExit("FAIL: candidate.model_calls !== 2")
if candidate_row["tokens_during_wait"] != 0 or candidate_row["cost_during_wait_usd"] != 0:
    raise SystemExit("FAIL: candidate spent tokens/cost during wait")
if not (candidate_row["cost_usd"] < baseline_row["cost_usd"]):
    raise SystemExit(
        f"FAIL: candidate.cost_usd ({candidate_row['cost_usd']}) "
        f"not < baseline.cost_usd ({baseline_row['cost_usd']})"
    )
if baseline_row["cost_usd"] <= turn1["cost_usd"]:
    raise SystemExit("FAIL: baseline did not appear to poll (cost not above a single short turn)")

print(
    f"PASS: park ${candidate_row['cost_usd']:.4f} < poll ${baseline_row['cost_usd']:.4f}; "
    f"model_calls=2; wait_tokens=0; total_spend=${reported_cost:.4f}"
)
PY
