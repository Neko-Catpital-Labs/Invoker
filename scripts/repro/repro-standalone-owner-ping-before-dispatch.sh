#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/inv-ping.XXXXXX")"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

SOCKET_PATH="$TMP_ROOT/ipc.sock"

if [[ ! -f "$ROOT_DIR/packages/transport/dist/index.js" ]]; then
  (cd "$ROOT_DIR" && pnpm --filter @invoker/transport build)
fi

echo "==> reproduce standalone owner-ping race window with real IPC transport"
(
  cd "$ROOT_DIR"
  REPRO_SOCKET="$SOCKET_PATH" node \
    --import 'data:text/javascript,import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("./scripts/repro/compiled-workspace-loader.mjs", pathToFileURL("./"));' \
    --input-type=module <<'NODE'
import { IpcBus, TransportErrorCode } from './packages/transport/dist/index.js';

const socketPath = process.env.REPRO_SOCKET;
const owner = new IpcBus(socketPath, { allowServe: true, requestDeadlineMs: 500 });
let client;

try {
  await owner.ready();
  client = new IpcBus(socketPath, { allowServe: false, requestDeadlineMs: 500 });
  await client.ready();

  let dispatchPollRan = false;
  const runLaunchDispatchPoll = async () => {
    dispatchPollRan = true;
  };

  await runLaunchDispatchPoll();

  try {
    await client.request('headless.owner-ping', {});
    throw new Error('expected owner-ping to fail before the owner handler is registered');
  } catch (err) {
    if (err?.code !== TransportErrorCode.NO_HANDLER) {
      throw err;
    }
  }

  if (!dispatchPollRan) {
    throw new Error('dispatch poll did not run before owner-ping was checked');
  }

  owner.onRequest('headless.owner-ping', async () => ({
    ok: true,
    ownerId: 'owner-race-repro',
    mode: 'standalone',
  }));

  const response = await client.request('headless.owner-ping', {});
  if (response?.ok !== true || response?.mode !== 'standalone') {
    throw new Error(`unexpected owner-ping response after registration: ${JSON.stringify(response)}`);
  }

  console.log('PASS: IPC can be reachable while owner-ping returns NO_HANDLER before registration');
  console.log('PASS: owner-ping succeeds after registration, so dispatch polling must start after handlers');
} finally {
  client?.disconnect();
  owner.disconnect();
}
NODE
)

echo
echo "==> verify production standalone owner registers handlers before dispatch polling"
(
  cd "$ROOT_DIR"
  pnpm --filter @invoker/app exec vitest run \
    src/__tests__/standalone-owner-handler-ordering.test.ts
)
