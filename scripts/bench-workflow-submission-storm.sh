#!/usr/bin/env bash
# Measures real per-submission wall-clock latency for `./run.sh --headless
# --no-track run <plan.yaml>` under a storm of N rapid submissions.
#
# Unlike scripts/repro/repro-headless-thundering-herd.sh (which asserts
# process-count invariants for concurrent *retries*), this measures the
# initial `run` submission path itself, sequentially, against a single
# already-warm standalone owner. The bootstrap workflow creates an
# approval-gated prerequisite, and the timed submissions depend on that
# prerequisite so the benchmark covers submission cost without turning into
# an executor throughput test.
#
# Usage:
#   bash scripts/bench-workflow-submission-storm.sh [--count N] [--gate] [--budget-ms N]
#
# Exit nonzero for setup failures or when no valid samples are collected;
# prints a per-submission timing table and summary stats (min/p50/p95/max/mean).
#
# --gate: exit 1 when p95 latency exceeds --budget-ms (default 1000). Gates
# on p95 rather than max/every-sample so one noisy-CI-runner outlier can't
# flake the check while a real regression (e.g. the cold-owner-connection
# stall this script originally caught) still fails it reliably.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
IPC_SOCKET="$TMP_DIR/ipc-transport.sock"
BLOCKER_PLAN_PATH="$TMP_DIR/blocker-plan.yaml"
PLAN_PATH="$TMP_DIR/storm-plan.yaml"
CONFIG_PATH="$TMP_DIR/config.json"
REMOTE_REPO="$TMP_DIR/remote.git"
TIMINGS_FILE="$TMP_DIR/timings.txt"
COUNT=50
KEEP_TMP=0
OWNER_PID=""
GATE=0
BUDGET_MS=1000
# Real Electron boot legitimately takes a few seconds — this is a generous
# ceiling to catch the "cold connection stalls for the full 60s bootstrap
# timeout" regression class, not a tight steady-state budget like BUDGET_MS.
BOOTSTRAP_BUDGET_MS=15000

while [[ $# -gt 0 ]]; do
  case "$1" in
    --count) COUNT="$2"; shift 2 ;;
    --keep-tmp) KEEP_TMP=1; shift ;;
    --gate) GATE=1; shift ;;
    --budget-ms) BUDGET_MS="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

owner_pid_is_live() {
  local pid="$1"
  local command
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(ps -p "$pid" -ww -o command= 2>/dev/null || true)"
  [[ "$command" == *"packages/app/dist/main.js"* && "$command" == *"--headless owner-serve"* ]]
}

read_owner_pid() {
  local marker="$DB_DIR/invoker.db.owner"
  local pid
  [[ -f "$marker" ]] || return 1
  pid="$(<"$marker")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  owner_pid_is_live "$pid" || return 1
  printf '%s\n' "$pid"
}

wait_for_owner_exit() {
  local pid="$1"
  for _ in {1..50}; do
    owner_pid_is_live "$pid" || return 0
    sleep 0.1
  done
  return 1
}

stop_owner_pid() {
  local pid="$1"
  owner_pid_is_live "$pid" || return 0
  kill "$pid" 2>/dev/null || true
  if ! wait_for_owner_exit "$pid"; then
    kill -KILL "$pid" 2>/dev/null || true
    wait_for_owner_exit "$pid" || true
  fi
}

stop_owner() {
  local marker_pid=""
  if [[ -n "${OWNER_PID:-}" ]]; then
    stop_owner_pid "$OWNER_PID"
  fi
  marker_pid="$(read_owner_pid 2>/dev/null || true)"
  if [[ -n "$marker_pid" && "$marker_pid" != "${OWNER_PID:-}" ]]; then
    stop_owner_pid "$marker_pid"
  fi
}

original_owner_is_live() {
  local current_pid
  current_pid="$(read_owner_pid 2>/dev/null)" || return 1
  [[ "$current_pid" == "$OWNER_PID" ]] && owner_pid_is_live "$OWNER_PID"
}

skip_submission() {
  local i="$1"
  local reason="$2"
  local ms="${3:-}"
  if [[ -n "$ms" ]]; then
    printf 'submission %3d: skipped (%s after %dms)\n' "$i" "$reason" "$ms"
  else
    printf 'submission %3d: skipped (%s)\n' "$i" "$reason"
  fi
}

cleanup() {
  stop_owner
  if [[ "$KEEP_TMP" -eq 1 ]]; then
    echo "==> Kept tmp dir: $TMP_DIR" >&2
  else
    # The killed owner process may not have released open file handles
    # (SQLite WAL, socket) the instant pkill returns — retry briefly rather
    # than leaving noisy "Directory not empty" warnings on every run.
    for _ in 1 2 3 4 5; do
      rm -rf "$TMP_DIR" 2>/dev/null && break
      sleep 0.3
    done
  fi
}
trap cleanup EXIT

mkdir -p "$DB_DIR"

pushd "$ROOT_DIR" >/dev/null

if [[ ! -f packages/app/dist/headless-client.js ]]; then
  echo "==> Building @invoker/app (headless-client.js missing)"
  pnpm --filter @invoker/app build >/dev/null
fi
git init --bare "$REMOTE_REPO" >/dev/null 2>&1
SEED_REPO="$TMP_DIR/seed-repo"
git init "$SEED_REPO" >/dev/null 2>&1
git -C "$SEED_REPO" config user.email bench@example.invalid
git -C "$SEED_REPO" config user.name "Bench Runner"
printf 'bench repository\n' > "$SEED_REPO/README.md"
git -C "$SEED_REPO" add README.md
git -C "$SEED_REPO" commit -m "seed benchmark repository" >/dev/null 2>&1
git -C "$SEED_REPO" branch -M main
git -C "$SEED_REPO" remote add origin "$REMOTE_REPO"
git -C "$SEED_REPO" push origin main >/dev/null 2>&1

cat > "$BLOCKER_PLAN_PATH" <<EOF
name: Workflow Submission Storm Blocker
onFinish: none
baseBranch: main
tasks:
  - id: root
    description: Approval-gated blocker
    command: echo blocker
    requiresManualApproval: true
EOF

python3 - "$BLOCKER_PLAN_PATH" "$REMOTE_REPO" <<'PY'
from pathlib import Path
import sys
plan_path = Path(sys.argv[1])
remote_repo = Path(sys.argv[2]).as_uri()
contents = plan_path.read_text()
plan_path.write_text(contents.replace(
    "name: Workflow Submission Storm Blocker\n",
    f"name: Workflow Submission Storm Blocker\nrepoUrl: {remote_repo}\n",
    1,
))
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

echo "==> Submission 0 (bootstrap): spawns + waits for a REAL persistent owner process, excluded from the p95 stats below"
echo "    (NOT using INVOKER_HEADLESS_STANDALONE=1 — that runs in-process with no owner at all,"
echo "     which under-measures every later submission's real IPC-delegation cost)"
BOOTSTRAP_START=$(date +%s%N)
env "${COMMON_ENV[@]}" ./run.sh --headless --no-track run "$BLOCKER_PLAN_PATH" \
  >"$TMP_DIR/bootstrap.stdout.log" 2>"$TMP_DIR/bootstrap.stderr.log"
BOOTSTRAP_END=$(date +%s%N)
BOOTSTRAP_MS=$(( (BOOTSTRAP_END - BOOTSTRAP_START) / 1000000 ))
echo "    bootstrap submission: ${BOOTSTRAP_MS}ms (real owner boot + first submit, excluded from p95 — checked separately below)"

if [[ "$GATE" -eq 1 && "$BOOTSTRAP_MS" -gt "$BOOTSTRAP_BUDGET_MS" ]]; then
  echo "  GATE FAIL: bootstrap submission took ${BOOTSTRAP_MS}ms, exceeds bootstrap budget=${BOOTSTRAP_BUDGET_MS}ms" >&2
  echo "  (this is the exact failure mode of a client connection that never retries after its first failed attempt)" >&2
  exit 1
fi

if ! grep -q 'Delegated to owner — workflow: wf-' "$TMP_DIR/bootstrap.stdout.log"; then
  echo "bench: bootstrap submission failed to produce a workflow id" >&2
  cat "$TMP_DIR/bootstrap.stdout.log" >&2 || true
  cat "$TMP_DIR/bootstrap.stderr.log" >&2 || true
  exit 1
fi
if ! OWNER_PID="$(read_owner_pid)"; then
  echo "bench: bootstrap did not leave a live standalone owner marker at $DB_DIR/invoker.db.owner" >&2
  cat "$TMP_DIR/bootstrap.stdout.log" >&2 || true
  cat "$TMP_DIR/bootstrap.stderr.log" >&2 || true
  exit 1
fi
BLOCKER_WORKFLOW_ID="$(
  sed -n 's/.*workflow: \(wf-[^[:space:]]*\).*/\1/p' "$TMP_DIR/bootstrap.stdout.log" | head -1
)"
if [[ -z "$BLOCKER_WORKFLOW_ID" ]]; then
  echo "bench: bootstrap submission did not report a workflow id" >&2
  cat "$TMP_DIR/bootstrap.stdout.log" >&2 || true
  cat "$TMP_DIR/bootstrap.stderr.log" >&2 || true
  exit 1
fi

python3 - "$PLAN_PATH" "$REMOTE_REPO" "$BLOCKER_WORKFLOW_ID" <<'PY'
from pathlib import Path
import sys

plan_path = Path(sys.argv[1])
remote_repo = Path(sys.argv[2]).as_uri()
blocker_workflow_id = sys.argv[3]
plan_path.write_text(f"""name: Workflow Submission Storm Bench
repoUrl: {remote_repo}
onFinish: none
baseBranch: main
externalDependencies:
  - workflowId: {blocker_workflow_id}
    taskId: root
    gatePolicy: completed
tasks:
  - id: root
    description: Root task
    command: echo root
""")
PY

echo "==> Submitting $COUNT workflows sequentially against the warm owner"
: > "$TIMINGS_FILE"
SKIPPED=0
for i in $(seq 1 "$COUNT"); do
  if ! original_owner_is_live; then
    skip_submission "$i" "original owner is no longer the live marker before run"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  START=$(date +%s%N)
  env "${COMMON_ENV[@]}" ./run.sh --headless --no-track run "$PLAN_PATH" \
    >"$TMP_DIR/run-$i.stdout.log" 2>"$TMP_DIR/run-$i.stderr.log"
  END=$(date +%s%N)
  MS=$(( (END - START) / 1000000 ))
  if ! original_owner_is_live; then
    skip_submission "$i" "original owner was replaced or stopped during run" "$MS"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  echo "$MS" >> "$TIMINGS_FILE"
  printf 'submission %3d: %5dms\n' "$i" "$MS"
done

if [[ ! -s "$TIMINGS_FILE" ]]; then
  echo "bench: no valid warm-owner samples collected; skipped=$SKIPPED" >&2
  exit 1
fi

echo
echo "==> Summary (ms, sequential, warm owner, N=$(wc -l < "$TIMINGS_FILE" | tr -d ' '), skipped=$SKIPPED)"
python3 - "$TIMINGS_FILE" "$GATE" "$BUDGET_MS" <<'PY'
import sys
vals = sorted(int(l.strip()) for l in open(sys.argv[1]) if l.strip())
gate = sys.argv[2] == "1"
budget_ms = int(sys.argv[3])
n = len(vals)
def pct(p):
    idx = min(n - 1, int(round(p * (n - 1))))
    return vals[idx]
p95 = pct(0.95)
print(f"  count={n}")
print(f"  min={vals[0]}ms")
print(f"  p50={pct(0.50)}ms")
print(f"  p95={p95}ms")
print(f"  max={vals[-1]}ms")
print(f"  mean={sum(vals)/n:.1f}ms")
over_budget = sum(1 for v in vals if v > budget_ms)
print(f"  over {budget_ms}ms budget: {over_budget}/{n}")
if gate:
    if p95 > budget_ms:
        print(f"  GATE FAIL: p95={p95}ms exceeds budget={budget_ms}ms")
        sys.exit(1)
    print(f"  GATE PASS: p95={p95}ms within budget={budget_ms}ms")
PY

popd >/dev/null
