#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION="${1:---expect-success}"
TMP_DIR="$(mktemp -d)"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
SOCKET_PATH="$DB_DIR/ipc-transport.sock"
PLAN_PATH="$TMP_DIR/repro-plan.yaml"
IPC_SERVER_TS="$TMP_DIR/ipc-server.ts"
SEED_STDOUT="$TMP_DIR/seed.stdout.log"
SEED_STDERR="$TMP_DIR/seed.stderr.log"
GUI_STDOUT="$TMP_DIR/gui.stdout.log"
GUI_STDERR="$TMP_DIR/gui.stderr.log"
RECREATE_STDOUT="$TMP_DIR/recreate.stdout.log"
RECREATE_STDERR="$TMP_DIR/recreate.stderr.log"

cleanup() {
  if [[ -n "${GUI_OWNER_PID:-}" ]]; then
    kill "$GUI_OWNER_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${GUI_PID:-}" ]]; then
    kill "$GUI_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${IPC_SERVER_PID:-}" ]]; then
    kill "$IPC_SERVER_PID" >/dev/null 2>&1 || true
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
name: GUI Owner Delegation Repro
repoUrl: git@github.com:test/repo.git
tasks:
  - id: root
    description: Root task
    command: echo "hello"
EOF

cat > "$IPC_SERVER_TS" <<EOF
import { IpcBus } from '${ROOT_DIR}/packages/transport/src/ipc-bus.ts';

const socketPath = process.argv[2];
if (!socketPath) {
  throw new Error('Missing socket path');
}

const bus = new IpcBus(socketPath);
await bus.ready();
process.stdout.write('ready\n');
process.on('SIGTERM', () => {
  bus.disconnect();
  process.exit(0);
});
process.on('SIGINT', () => {
  bus.disconnect();
  process.exit(0);
});
setInterval(() => {}, 1000);
EOF

node --experimental-strip-types "$IPC_SERVER_TS" "$SOCKET_PATH" >"$TMP_DIR/ipc-server.log" 2>&1 &
IPC_SERVER_PID=$!

for _ in {1..50}; do
  if [[ -S "$SOCKET_PATH" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -S "$SOCKET_PATH" ]]; then
  echo "repro: IPC server socket did not come up" >&2
  exit 1
fi

ELECTRON_BIN="$ROOT_DIR/packages/app/node_modules/.bin/electron"
MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"

env \
  HOME="$HOME_DIR" \
  INVOKER_DB_DIR="$DB_DIR" \
  INVOKER_HEADLESS_STANDALONE=1 \
  "$ELECTRON_BIN" "$MAIN_JS" --headless --no-track run "$PLAN_PATH" \
  >"$SEED_STDOUT" 2>"$SEED_STDERR"

WORKFLOW_ID="$(sed -n 's/^Workflow ID: //p' "$SEED_STDOUT" | head -n1)"
if [[ -z "$WORKFLOW_ID" ]]; then
  echo "repro: failed to seed workflow id" >&2
  cat "$SEED_STDOUT" >&2 || true
  cat "$SEED_STDERR" >&2 || true
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
  "$ELECTRON_BIN" "$MAIN_JS" \
  >"$GUI_STDOUT" 2>"$GUI_STDERR" &
GUI_PID=$!

for _ in {1..100}; do
  if [[ -f "$DB_DIR/invoker.db.lock/pid" ]]; then
    GUI_OWNER_PID="$(cat "$DB_DIR/invoker.db.lock/pid" 2>/dev/null || true)"
    if [[ -n "$GUI_OWNER_PID" ]] && kill -0 "$GUI_OWNER_PID" >/dev/null 2>&1; then
      break
    fi
  fi
  sleep 0.1
done

if [[ ! -f "$DB_DIR/invoker.db.lock/pid" ]]; then
  echo "repro: GUI did not acquire DB ownership" >&2
  cat "$GUI_STDERR" >&2 || true
  exit 1
fi

GUI_OWNER_PID="$(cat "$DB_DIR/invoker.db.lock/pid" 2>/dev/null || true)"
if [[ -z "$GUI_OWNER_PID" ]] || ! kill -0 "$GUI_OWNER_PID" >/dev/null 2>&1; then
  echo "repro: GUI did not acquire DB ownership" >&2
  cat "$GUI_STDERR" >&2 || true
  exit 1
fi

sleep 3

set +e
env \
  HOME="$HOME_DIR" \
  INVOKER_DB_DIR="$DB_DIR" \
  "$ELECTRON_BIN" "$MAIN_JS" --headless recreate "$WORKFLOW_ID" \
  >"$RECREATE_STDOUT" 2>"$RECREATE_STDERR"
STATUS=$?
set -e

if [[ "$EXPECTATION" == "--expect-failure" ]]; then
  if grep -q 'requires an owner process' "$RECREATE_STDERR"; then
    echo "repro: confirmed headless recreate cannot reach GUI owner through external IPC server"
    exit 0
  fi
  echo "repro: expected owner-process delegation failure, but did not observe it" >&2
elif [[ "$EXPECTATION" == "--expect-success" ]]; then
  if [[ "$STATUS" -eq 0 ]] && ! grep -q 'requires an owner process' "$RECREATE_STDERR"; then
    EVENT_COUNT="$(sqlite3 "$DB_DIR/invoker.db" "select count(*) from events where task_id like '${WORKFLOW_ID}/%' and event_type='task.pending';")"
    echo "repro: confirmed headless recreate delegates to GUI owner through external IPC server"
    echo "workflow: $WORKFLOW_ID"
    echo "pending-events: $EVENT_COUNT"
    exit 0
  fi
  echo "repro: recreate delegation still failed unexpectedly" >&2
else
  echo "usage: $0 [--expect-failure|--expect-success]" >&2
  exit 2
fi

echo "seed stdout:" >&2
cat "$SEED_STDOUT" >&2 || true
echo "seed stderr:" >&2
cat "$SEED_STDERR" >&2 || true
echo "gui stderr:" >&2
cat "$GUI_STDERR" >&2 || true
echo "recreate stdout:" >&2
cat "$RECREATE_STDOUT" >&2 || true
echo "recreate stderr:" >&2
cat "$RECREATE_STDERR" >&2 || true
exit 1
