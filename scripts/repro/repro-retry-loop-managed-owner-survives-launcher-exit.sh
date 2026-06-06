#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/headless-lib.sh
source "$ROOT_DIR/scripts/headless-lib.sh"

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-managed-owner-survives.XXXXXX")"
owner_pid_file="$tmpdir/owner.pid"
owner_log="$tmpdir/owner.log"
db_dir="$tmpdir/db"
socket_path="$tmpdir/ipc.sock"
config_path="$tmpdir/config.json"

cleanup() {
  if [ -s "$owner_pid_file" ]; then
    kill "$(cat "$owner_pid_file")" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmpdir"
}
trap cleanup EXIT

cat > "$config_path" <<'JSON'
{
  "allowGraphMutation": true,
  "disableAutoRunOnStartup": true,
  "launchOutboxMode": "active"
}
JSON
mkdir -p "$db_dir"

wait_for_log() {
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if [ -f "$owner_log" ] && grep -Fq "standalone owner ready" "$owner_log"; then
      return 0
    fi
    sleep 0.2
  done
  echo "timed out waiting for standalone owner readiness" >&2
  [ -f "$owner_log" ] && tail -80 "$owner_log" >&2
  return 1
}

owner_ping() {
  INVOKER_IPC_SOCKET="$socket_path" node --input-type=module <<'NODE'
import { IpcBus } from './packages/transport/dist/index.js';
const bus = new IpcBus(undefined, { allowServe: false, requestDeadlineMs: 1000 });
try {
  await bus.ready();
  const response = await bus.request('headless.owner-ping', {});
  if (!response || response.ok !== true) {
    throw new Error(`unexpected response: ${JSON.stringify(response)}`);
  }
} finally {
  bus.disconnect();
}
NODE
}

(
  cd "$ROOT_DIR"
  env \
    INVOKER_DB_DIR="$db_dir" \
    INVOKER_IPC_SOCKET="$socket_path" \
    INVOKER_REPO_CONFIG_PATH="$config_path" \
    INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS=60000 \
    INVOKER_HEADLESS_STANDALONE=1 \
    nohup "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless owner-serve > "$owner_log" 2>&1 &
  printf '%s\n' "$!" > "$owner_pid_file"
)

wait_for_log
sleep 1

if ! kill -0 "$(cat "$owner_pid_file")" >/dev/null 2>&1; then
  echo "managed owner exited after launcher shell returned" >&2
  tail -80 "$owner_log" >&2 || true
  exit 1
fi

if ! owner_ping; then
  echo "managed owner did not answer owner-ping after launcher shell returned" >&2
  tail -80 "$owner_log" >&2 || true
  exit 1
fi

cat <<EOF
PASS: retry-loop managed owner survives launcher shell exit.

owner_pid=$(cat "$owner_pid_file")
db_dir=$db_dir
socket_path=$socket_path

Root cause guarded: a retry-loop helper that backgrounds owner-serve must detach
it from the helper shell, otherwise submitted launch-dispatch rows can be left
without a live dispatcher after the helper exits.
EOF
