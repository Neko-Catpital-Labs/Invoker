#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MAIN_JS="${INVOKER_APP_MAIN:-packages/app/dist/main.js}"
ELECTRON_SCRIPT="${INVOKER_ELECTRON_SCRIPT:-scripts/electron.cjs}"
WORKER_KIND="${INVOKER_REPRO_WORKER_KIND:-workflow-resume}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-worker-status-repro.XXXXXX")"
OWNER_PID=""

cleanup() {
  if [ -n "$OWNER_PID" ] && kill -0 "$OWNER_PID" >/dev/null 2>&1; then
    kill "$OWNER_PID" >/dev/null 2>&1 || true
    wait "$OWNER_PID" >/dev/null 2>&1 || true
  fi
  if [ "${KEEP_REPRO_ARTIFACTS:-0}" = "1" ]; then
    echo "repro artifacts kept at $TMP_DIR" >&2
  else
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

cd "$ROOT"

if [ ! -f "$MAIN_JS" ]; then
  echo "missing app bundle: $MAIN_JS" >&2
  echo "run: pnpm --filter @invoker/app build" >&2
  exit 2
fi

export HOME="$TMP_DIR/home"
export INVOKER_DB_DIR="$TMP_DIR/invoker-home"
export INVOKER_IPC_SOCKET="$INVOKER_DB_DIR/ipc-transport.sock"
export INVOKER_REPO_CONFIG_PATH="$TMP_DIR/config.json"
export INVOKER_API_PORT="${INVOKER_API_PORT:-$((4500 + (RANDOM % 500)))}"
export INVOKER_WEB_TOKEN=""
export INVOKER_HEADLESS_OWNER_IDLE_TIMEOUT_MS="${INVOKER_HEADLESS_OWNER_IDLE_TIMEOUT_MS:-60000}"

mkdir -p "$HOME" "$INVOKER_DB_DIR"
cat >"$INVOKER_REPO_CONFIG_PATH" <<'JSON'
{
  "autoFixRetries": 0,
  "disableAutoRunOnStartup": true,
  "e2eAutoFixEnabled": false,
  "prMaintenance": {
    "enabled": false
  }
}
JSON

"$ELECTRON_SCRIPT" "$MAIN_JS" --headless owner-serve >"$TMP_DIR/owner.log" 2>&1 &
OWNER_PID="$!"

ipc_request() {
  local channel="$1"
  local payload="$2"
  node --input-type=module - "$channel" "$payload" <<'NODE'
import { IpcBus } from './packages/transport/dist/index.js';

const [channel, rawPayload] = process.argv.slice(2);
const bus = new IpcBus(undefined, { allowServe: false });
await bus.ready();
try {
  const response = await bus.request(channel, JSON.parse(rawPayload));
  process.stdout.write(`${JSON.stringify(response)}\n`);
} finally {
  bus.disconnect();
}
NODE
}

for _ in $(seq 1 100); do
  if ipc_request 'headless.owner-ping' '{}' >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! ipc_request 'headless.owner-ping' '{}' >/dev/null 2>&1; then
  echo "owner did not become ready" >&2
  tail -n 80 "$TMP_DIR/owner.log" >&2 || true
  exit 2
fi

ipc_request 'headless.gui-mutation' "{\"channel\":\"invoker:start-worker\",\"args\":[\"$WORKER_KIND\"]}" >/dev/null

structured_json="$(ipc_request 'headless.query' '{"kind":"workers"}')"
structured_summary="$(STRUCTURED_JSON="$structured_json" node - "$WORKER_KIND" <<'NODE'
const workerKind = process.argv[2];
const snapshot = JSON.parse(process.env.STRUCTURED_JSON ?? '');
const worker = snapshot.workers?.find((candidate) => candidate.kind === workerKind);
if (!worker) {
  console.error(`structured owner snapshot omitted ${workerKind}`);
  process.exit(2);
}
process.stdout.write(`${JSON.stringify({
  lifecycle: worker.lifecycle,
  running: worker.running,
  desiredEnabled: worker.desiredEnabled,
})}\n`);
if (worker.lifecycle !== 'running' || worker.running !== true) {
  console.error(`structured owner snapshot did not report ${workerKind} as running`);
  process.exit(2);
}
NODE
)"

cli_stdout="$("$ELECTRON_SCRIPT" "$MAIN_JS" --headless query workers --output json 2>"$TMP_DIR/query.stderr")"
cli_summary="$(CLI_STDOUT="$cli_stdout" node - "$WORKER_KIND" <<'NODE'
const workerKind = process.argv[2];
const lines = (process.env.CLI_STDOUT ?? '').trim().split(/\r?\n/).filter(Boolean);
let snapshot;
for (let i = lines.length - 1; i >= 0; i -= 1) {
  try {
    snapshot = JSON.parse(lines[i]);
    break;
  } catch {
    // Keep scanning for the JSON payload; Electron startup logs may precede it.
  }
}
if (!snapshot) {
  console.error('query workers did not print a JSON worker snapshot');
  process.exit(2);
}
const worker = snapshot.workers?.find((candidate) => candidate.kind === workerKind);
if (!worker) {
  console.error(`query workers snapshot omitted ${workerKind}`);
  process.exit(2);
}
process.stdout.write(`${JSON.stringify({
  lifecycle: worker.lifecycle,
  running: worker.running,
  desiredEnabled: worker.desiredEnabled,
  controlDisabledReason: worker.controlDisabledReason,
})}\n`);
if (worker.lifecycle !== 'running' || worker.running !== true) {
  process.exit(1);
}
NODE
)" || {
  echo "FAIL repro-query-workers-live-status: query workers lost live owner runtime state" >&2
  echo "structured owner: $structured_summary" >&2
  echo "query workers:    ${cli_summary:-<unavailable>}" >&2
  echo "query stderr:     $TMP_DIR/query.stderr" >&2
  echo "owner log:        $TMP_DIR/owner.log" >&2
  exit 1
}

echo "PASS repro-query-workers-live-status: query workers matches live owner runtime state"
echo "structured owner: $structured_summary"
echo "query workers:    $cli_summary"
