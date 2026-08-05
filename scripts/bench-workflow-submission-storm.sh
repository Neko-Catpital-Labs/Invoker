#!/usr/bin/env bash
# Measures real per-submission wall-clock latency for `./run.sh --headless
# --no-track run <plan.yaml>` under a storm of N rapid submissions.
#
# Unlike scripts/repro/repro-headless-thundering-herd.sh (which asserts
# process-count invariants for concurrent *retries*), this measures the
# initial `run` submission path itself, sequentially, against a single
# already-warm standalone owner — so numbers reflect steady-state
# submission cost, not one-time Electron bootstrap.
#
# Usage:
#   bash scripts/bench-workflow-submission-storm.sh [--count N]
#
# Exit 0 always (this is a benchmark, not a pass/fail gate); prints a
# per-submission timing table and summary stats (min/p50/p95/max/mean).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
IPC_SOCKET="$TMP_DIR/ipc-transport.sock"
PLAN_PATH="$TMP_DIR/storm-plan.yaml"
CONFIG_PATH="$TMP_DIR/config.json"
REMOTE_REPO="$TMP_DIR/remote.git"
TIMINGS_FILE="$TMP_DIR/timings.txt"
COUNT=50
KEEP_TMP=0
OWNER_PID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --count) COUNT="$2"; shift 2 ;;
    --keep-tmp) KEEP_TMP=1; shift ;;
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

stop_owner() {
  [[ -n "${OWNER_PID:-}" ]] || return 0
  owner_pid_is_live "$OWNER_PID" || return 0
  kill "$OWNER_PID" 2>/dev/null || true
  if ! wait_for_owner_exit "$OWNER_PID"; then
    kill -KILL "$OWNER_PID" 2>/dev/null || true
    wait_for_owner_exit "$OWNER_PID" || true
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

cat > "$PLAN_PATH" <<EOF
name: Workflow Submission Storm Bench
onFinish: none
tasks:
  - id: root
    description: Root task
    command: echo root
EOF

python3 - "$PLAN_PATH" "$REMOTE_REPO" <<'PY'
from pathlib import Path
import sys
plan_path = Path(sys.argv[1])
remote_repo = Path(sys.argv[2]).as_uri()
contents = plan_path.read_text()
plan_path.write_text(contents.replace(
    "name: Workflow Submission Storm Bench\n",
    f"name: Workflow Submission Storm Bench\nrepoUrl: {remote_repo}\n",
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

echo "==> Submission 0 (bootstrap): spawns + waits for a REAL persistent owner process, excluded from stats"
echo "    (NOT using INVOKER_HEADLESS_STANDALONE=1 — that runs in-process with no owner at all,"
echo "     which under-measures every later submission's real IPC-delegation cost)"
BOOTSTRAP_START=$(date +%s%N)
env "${COMMON_ENV[@]}" ./run.sh --headless --no-track run "$PLAN_PATH" \
  >"$TMP_DIR/bootstrap.stdout.log" 2>"$TMP_DIR/bootstrap.stderr.log"
BOOTSTRAP_END=$(date +%s%N)
BOOTSTRAP_MS=$(( (BOOTSTRAP_END - BOOTSTRAP_START) / 1000000 ))
echo "    bootstrap submission: ${BOOTSTRAP_MS}ms (real owner boot + first submit, not counted below)"

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

echo "==> Submitting $COUNT workflows sequentially against the warm owner"
: > "$TIMINGS_FILE"
for i in $(seq 1 "$COUNT"); do
  START=$(date +%s%N)
  env "${COMMON_ENV[@]}" ./run.sh --headless --no-track run "$PLAN_PATH" \
    >"$TMP_DIR/run-$i.stdout.log" 2>"$TMP_DIR/run-$i.stderr.log"
  END=$(date +%s%N)
  MS=$(( (END - START) / 1000000 ))
  echo "$MS" >> "$TIMINGS_FILE"
  printf 'submission %3d: %5dms\n' "$i" "$MS"
done

echo
echo "==> Summary (ms, sequential, warm owner, N=$COUNT)"
python3 - "$TIMINGS_FILE" <<'PY'
import sys
vals = sorted(int(l.strip()) for l in open(sys.argv[1]) if l.strip())
n = len(vals)
def pct(p):
    idx = min(n - 1, int(round(p * (n - 1))))
    return vals[idx]
print(f"  count={n}")
print(f"  min={vals[0]}ms")
print(f"  p50={pct(0.50)}ms")
print(f"  p95={pct(0.95)}ms")
print(f"  max={vals[-1]}ms")
print(f"  mean={sum(vals)/n:.1f}ms")
over_budget = sum(1 for v in vals if v > 1000)
print(f"  over 1000ms budget: {over_budget}/{n}")
PY

popd >/dev/null
