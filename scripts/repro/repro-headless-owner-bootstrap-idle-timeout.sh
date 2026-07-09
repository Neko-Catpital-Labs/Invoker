#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/headless-lib.sh"

TMP_ROOT="$(mktemp -d -t invoker-owner-idle-repro.XXXXXX)"
OWNER_PID=""

cleanup() {
  if [[ -n "$OWNER_PID" ]]; then
    local children
    children="$(pgrep -P "$OWNER_PID" 2>/dev/null || true)"
    if [[ -n "$children" ]]; then
      # shellcheck disable=SC2086
      kill $children 2>/dev/null || true
    fi
    kill "$OWNER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

wait_for_log() {
  local file="$1"
  local needle="$2"
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if [[ -f "$file" ]] && grep -Fq "$needle" "$file"; then
      return 0
    fi
    sleep 0.2
  done
  echo "timed out waiting for '$needle' in $file" >&2
  [[ -f "$file" ]] && tail -80 "$file" >&2
  return 1
}

owner_ping() {
  local socket_path="$1"
  INVOKER_IPC_SOCKET="$socket_path" node --input-type=module <<'NODE'
import { IpcBus } from './packages/transport/dist/index.js';
const bus = new IpcBus(undefined, { allowServe: false, requestDeadlineMs: 500 });
try {
  await bus.ready();
  const response = await bus.request('headless.owner-ping', {});
  if (!response || response.ok !== true) {
    throw new Error(`unexpected response: ${JSON.stringify(response)}`);
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
} finally {
  bus.disconnect();
}
NODE
}

start_owner() {
  local db_dir="$1"
  local socket_path="$2"
  local idle_ms="$3"
  local log_file="$4"
  INVOKER_DB_DIR="$db_dir" \
    INVOKER_IPC_SOCKET="$socket_path" \
    INVOKER_REPO_CONFIG_PATH="$TMP_ROOT/config.json" \
    INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS="$idle_ms" \
    INVOKER_HEADLESS_STANDALONE=1 \
    "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless owner-serve >"$log_file" 2>&1 &
  OWNER_PID="$!"
  wait_for_log "$log_file" "standalone owner ready"
}

cat > "$TMP_ROOT/config.json" <<'JSON'
{
  "allowGraphMutation": true,
  "disableAutoRunOnStartup": true
}
JSON

SHORT_DB="$TMP_ROOT/short-db"
SHORT_SOCKET="$TMP_ROOT/short.sock"
SHORT_LOG="$TMP_ROOT/short-owner.log"
mkdir -p "$SHORT_DB"
start_owner "$SHORT_DB" "$SHORT_SOCKET" 50 "$SHORT_LOG"
sleep 1
if owner_ping "$SHORT_SOCKET" >"$TMP_ROOT/short-ping.out" 2>"$TMP_ROOT/short-ping.err"; then
  echo "FAIL: short-idle owner still answered after idle expiry" >&2
  cat "$TMP_ROOT/short-ping.out" >&2
  exit 1
fi
cleanup
trap cleanup EXIT
OWNER_PID=""

LONG_DB="$TMP_ROOT/long-db"
LONG_SOCKET="$TMP_ROOT/long.sock"
LONG_LOG="$TMP_ROOT/long-owner.log"
mkdir -p "$LONG_DB"
start_owner "$LONG_DB" "$LONG_SOCKET" 60000 "$LONG_LOG"
if ! owner_ping "$LONG_SOCKET" >"$TMP_ROOT/long-ping.out" 2>"$TMP_ROOT/long-ping.err"; then
  echo "FAIL: long-idle owner did not answer owner-ping" >&2
  cat "$TMP_ROOT/long-ping.err" >&2
  exit 1
fi

echo "PASS: short owner idle timeout drops owner-ping; long timeout keeps bootstrap owner discoverable"
