#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
PLAN_PATH="$TMP_DIR/parallel-plan.yaml"
CONFIG_PATH="$DB_DIR/config.json"
OWNER_STDOUT="$TMP_DIR/owner.stdout.log"
OWNER_STDERR="$TMP_DIR/owner.stderr.log"
DELEGATE_STDOUT="$TMP_DIR/delegate.stdout.log"
DELEGATE_STDERR="$TMP_DIR/delegate.stderr.log"
SEED1_STDOUT="$TMP_DIR/seed1.stdout.log"
SEED1_STDERR="$TMP_DIR/seed1.stderr.log"
SEED2_STDOUT="$TMP_DIR/seed2.stdout.log"
SEED2_STDERR="$TMP_DIR/seed2.stderr.log"
REPRO_TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-20}"

cleanup() {
  if [[ -n "${OWNER_PID:-}" ]]; then
    kill "$OWNER_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${DELEGATE_PID:-}" ]]; then
    kill "$DELEGATE_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$DB_DIR"

pushd "$ROOT_DIR" >/dev/null

if [[ ! -f packages/app/dist/main.js ]]; then
  pnpm --filter @invoker/app build >/dev/null
fi

cat > "$PLAN_PATH" <<'EOF'
name: Parallel Workflow Recreate Repro
repoUrl: git@github.com:test/repo.git
tasks:
  - id: slow-root
    description: Slow root task
    command: sleep 2
EOF

cat > "$CONFIG_PATH" <<'EOF'
{
  "maxConcurrency": 4
}
EOF

ELECTRON_BIN="$ROOT_DIR/packages/app/node_modules/.bin/electron"
MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"

env \
  HOME="$HOME_DIR" \
  INVOKER_DB_DIR="$DB_DIR" \
  INVOKER_HEADLESS_STANDALONE=1 \
  "$ELECTRON_BIN" "$MAIN_JS" --headless --no-track run "$PLAN_PATH" \
  >"$SEED1_STDOUT" 2>"$SEED1_STDERR"

env \
  HOME="$HOME_DIR" \
  INVOKER_DB_DIR="$DB_DIR" \
  INVOKER_HEADLESS_STANDALONE=1 \
  "$ELECTRON_BIN" "$MAIN_JS" --headless --no-track run "$PLAN_PATH" \
  >"$SEED2_STDOUT" 2>"$SEED2_STDERR"

WORKFLOW_1="$(sed -n 's/^Workflow ID: //p' "$SEED1_STDOUT" | head -n1)"
WORKFLOW_2="$(sed -n 's/^Workflow ID: //p' "$SEED2_STDOUT" | head -n1)"
if [[ -z "$WORKFLOW_1" || -z "$WORKFLOW_2" ]]; then
  echo "repro: failed to seed workflow ids" >&2
  cat "$SEED1_STDOUT" >&2 || true
  cat "$SEED1_STDERR" >&2 || true
  cat "$SEED2_STDOUT" >&2 || true
  cat "$SEED2_STDERR" >&2 || true
  exit 1
fi

for _ in {1..100}; do
  if [[ ! -f "$DB_DIR/invoker.db.lock/pid" ]]; then
    break
  fi
  LOCK_PID="$(cat "$DB_DIR/invoker.db.lock/pid" 2>/dev/null || true)"
  if [[ -z "$LOCK_PID" ]] || ! kill -0 "$LOCK_PID" >/dev/null 2>&1; then
    rm -rf "$DB_DIR/invoker.db.lock"
    break
  fi
  sleep 0.1
done

env \
  HOME="$HOME_DIR" \
  INVOKER_DB_DIR="$DB_DIR" \
  INVOKER_HEADLESS_STANDALONE=1 \
  "$ELECTRON_BIN" "$MAIN_JS" --headless recreate "$WORKFLOW_1" \
  >"$OWNER_STDOUT" 2>"$OWNER_STDERR" &
OWNER_PID=$!

for _ in {1..100}; do
  if [[ -f "$DB_DIR/invoker.db.lock/pid" ]]; then
    OWNER_LOCK_PID="$(cat "$DB_DIR/invoker.db.lock/pid" 2>/dev/null || true)"
    if [[ -n "$OWNER_LOCK_PID" ]] && kill -0 "$OWNER_LOCK_PID" >/dev/null 2>&1; then
      break
    fi
  fi
  sleep 0.1
done

if [[ ! -f "$DB_DIR/invoker.db.lock/pid" ]]; then
  echo "repro: standalone owner did not acquire DB ownership" >&2
  cat "$OWNER_STDERR" >&2 || true
  cat "$OWNER_STDOUT" >&2 || true
  exit 1
fi

env \
  HOME="$HOME_DIR" \
  INVOKER_DB_DIR="$DB_DIR" \
  "$ELECTRON_BIN" "$MAIN_JS" --headless recreate "$WORKFLOW_2" \
  >"$DELEGATE_STDOUT" 2>"$DELEGATE_STDERR" &
DELEGATE_PID=$!

sleep 3

start1="$(grep -n "TaskRunner.executeTask BEGIN taskId=${WORKFLOW_1}/slow-root" "$OWNER_STDOUT" | head -n1 | cut -d: -f1 || true)"
start2="$(grep -n "TaskRunner.executeTask BEGIN taskId=${WORKFLOW_2}/slow-root" "$OWNER_STDOUT" | head -n1 | cut -d: -f1 || true)"
fail1="$(grep -n "parsedType=failed taskId=${WORKFLOW_1}/slow-root" "$OWNER_STDOUT" | head -n1 | cut -d: -f1 || true)"
fail2="$(grep -n "parsedType=failed taskId=${WORKFLOW_2}/slow-root" "$OWNER_STDOUT" | head -n1 | cut -d: -f1 || true)"

kill "$OWNER_PID" >/dev/null 2>&1 || true
kill "$DELEGATE_PID" >/dev/null 2>&1 || true

start1="${start1:-}"
start2="${start2:-}"
fail1="${fail1:-}"
fail2="${fail2:-}"

if [[ -z "$start1" || -z "$start2" || -z "$fail1" || -z "$fail2" ]]; then
  echo "repro: timed out waiting for both workflows to start and fail" >&2
  cat "$OWNER_STDERR" >&2 || true
  cat "$OWNER_STDOUT" >&2 || true
  cat "$DELEGATE_STDERR" >&2 || true
  exit 1
fi

if (( start2 > fail1 )); then
  echo "repro: second workflow did not start until after the first failed" >&2
  echo "start1-line: $start1" >&2
  echo "fail1-line: $fail1" >&2
  echo "start2-line: $start2" >&2
  cat "$OWNER_STDOUT" >&2 || true
  exit 1
fi

echo "repro: confirmed recreate runs in parallel across workflows through the standalone owner broker"
echo "workflow-1: $WORKFLOW_1"
echo "workflow-2: $WORKFLOW_2"
echo "start1-line: $start1"
echo "start2-line: $start2"
echo "fail1-line: $fail1"
echo "fail2-line: $fail2"
