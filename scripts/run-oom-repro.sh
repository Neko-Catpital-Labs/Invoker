#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-safe}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="scripts/repro-workflow-mutation-oom.mjs"

if [[ "$MODE" != "safe" && "$MODE" != "sandbox" ]]; then
  echo "usage: $0 [safe|sandbox]" >&2
  exit 2
fi

if [[ "$MODE" == "safe" ]]; then
  NODE_HEAP_MB="${REPRO_NODE_HEAP_MB:-192}"
  echo "[runner] mode=safe node_heap_mb=${NODE_HEAP_MB}"
  cd "$ROOT_DIR"
  exec node --max-old-space-size="${NODE_HEAP_MB}" "$SCRIPT_PATH" --mode=safe
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[runner] docker is required for sandbox mode" >&2
  exit 1
fi

DOCKER_MEMORY="${REPRO_DOCKER_MEMORY:-768m}"
NODE_HEAP_MB="${REPRO_NODE_HEAP_MB:-320}"
echo "[runner] mode=sandbox docker_memory=${DOCKER_MEMORY} node_heap_mb=${NODE_HEAP_MB}"
cd "$ROOT_DIR"
exec docker run --rm \
  --memory "${DOCKER_MEMORY}" \
  -v "${ROOT_DIR}:/repo" \
  -w /repo \
  -e REPRO_ROWS_PER_CYCLE \
  -e REPRO_PAYLOAD_BYTES \
  -e REPRO_RENEWS_PER_CYCLE \
  -e REPRO_MAX_CYCLES \
  -e REPRO_EXPORT_EVERY \
  -e REPRO_MAX_DB_MB \
  -e REPRO_SQLITE_HARD_HEAP_LIMIT_MB \
  -e REPRO_TIMEOUT_SEC \
  node:22 \
  node --max-old-space-size="${NODE_HEAP_MB}" "$SCRIPT_PATH" --mode=sandbox
