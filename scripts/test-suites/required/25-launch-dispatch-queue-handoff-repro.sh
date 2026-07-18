#!/usr/bin/env bash
# Standalone regression proof for stale launch-dispatch acknowledgements blocking queued work.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

ensure_built() {
  local package_name="$1"
  local package_dir="$2"
  if [ ! -f "$package_dir/dist/index.js" ] ||
    find "$package_dir/src" -type f -newer "$package_dir/dist/index.js" | grep -q .; then
    pnpm --filter "$package_name" build
  fi
}

ensure_built @invoker/workflow-graph "$ROOT/packages/workflow-graph"
ensure_built @invoker/contracts "$ROOT/packages/contracts"
ensure_built @invoker/workflow-core "$ROOT/packages/workflow-core"
ensure_built @invoker/data-store "$ROOT/packages/data-store"

exec node \
  --loader "$ROOT/scripts/repro/compiled-workspace-loader.mjs" \
  "$ROOT/scripts/repro/repro-launch-dispatch-queue-handoff.mjs"
