#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
WORKFLOWS_FILE="$TMP_DIR/workflows.txt"
FAKE_IPC="$TMP_DIR/headless-ipc.js"
STATE_FILE="$TMP_DIR/state.json"
EXPECT="${1:-}"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [[ "$EXPECT" == "--expect" ]]; then
  shift
  EXPECT="${1:-}"
fi
if [[ -z "$EXPECT" ]]; then
  EXPECT="fixed"
fi
if [[ "$EXPECT" != "fixed" ]]; then
  echo "repro: only --expect fixed is supported" >&2
  exit 2
fi

for i in $(seq 1 12); do
  printf 'wf-100-%d\n' "$i" >> "$WORKFLOWS_FILE"
done

cat > "$FAKE_IPC" <<'JS'
#!/usr/bin/env node
const fs = require('node:fs');

const args = process.argv.slice(2);
const parallelIndex = args.indexOf('--parallel');
const parallel = parallelIndex >= 0 ? Number.parseInt(args[parallelIndex + 1] ?? '0', 10) : 0;
const statePath = process.env.REPRO_STATE_FILE;
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', async () => {
  const lines = Buffer.concat(chunks).toString('utf8').trim().split('\n').filter(Boolean);
  let next = 0;
  let active = 0;
  let maxActive = 0;
  async function worker() {
    while (next < lines.length) {
      const line = lines[next++];
      const item = JSON.parse(line);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      process.stdout.write(JSON.stringify({ ...item, ok: true }) + '\n');
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, parallel), lines.length) }, () => worker()));
  fs.writeFileSync(statePath, JSON.stringify({ parallel, maxActive, count: lines.length }));
});
JS
chmod +x "$FAKE_IPC"

pushd "$ROOT_DIR" >/dev/null

REPRO_STATE_FILE="$STATE_FILE" \
INVOKER_HEADLESS_WORKFLOW_IDS_FILE="$WORKFLOWS_FILE" \
INVOKER_HEADLESS_IPC_HELPER="$FAKE_IPC" \
  bash scripts/recreate-all.sh --parallel 3 >/dev/null

python3 - "$STATE_FILE" <<'PY'
import json
import sys
state = json.load(open(sys.argv[1], encoding="utf-8"))
if state["parallel"] != 3:
    raise SystemExit(f"repro: expected --parallel 3 to reach batch dispatcher, saw {state['parallel']}")
if state["maxActive"] > 3:
    raise SystemExit(f"repro: dispatch concurrency exceeded bound: {state['maxActive']} > 3")
if state["count"] != 12:
    raise SystemExit(f"repro: expected 12 dispatched workflows, saw {state['count']}")
print("repro: fixed")
print(f"dispatch-count: {state['count']}")
print(f"parallel: {state['parallel']}")
print(f"max-active: {state['maxActive']}")
PY

REPRO_STATE_FILE="$STATE_FILE" \
INVOKER_HEADLESS_WORKFLOW_IDS_FILE="$WORKFLOWS_FILE" \
INVOKER_HEADLESS_IPC_HELPER="$FAKE_IPC" \
  bash scripts/recreate-all.sh >/dev/null

python3 - "$STATE_FILE" <<'PY'
import json
import sys
state = json.load(open(sys.argv[1], encoding="utf-8"))
if state["parallel"] != 4:
    raise SystemExit(f"repro: expected default parallelism 4, saw {state['parallel']}")
if state["maxActive"] > 4:
    raise SystemExit(f"repro: default dispatch concurrency exceeded bound: {state['maxActive']} > 4")
print(f"default-parallel: {state['parallel']}")
print(f"default-max-active: {state['maxActive']}")
PY
