#!/bin/bash
# Build and launch the Invoker Electron app (GUI mode).
# Also used for headless mode: ./run.sh --headless run <plan.yaml>
set -e
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

# Unset ELECTRON_RUN_AS_NODE so Electron loads its full API.
unset ELECTRON_RUN_AS_NODE

pnpm --filter @invoker/core build
pnpm --filter @invoker/persistence build
pnpm --filter @invoker/executors build
pnpm --filter @invoker/surfaces build
pnpm --filter @invoker/ui build
pnpm --filter @invoker/app build

if [ "$1" = "--headless" ]; then
  # Pass remaining args to headless mode
  shift
  ./packages/app/node_modules/.bin/electron packages/app/dist/main.js --headless "$@"
else
  ELECTRON_ENABLE_LOGGING=1 pnpm --filter @invoker/app start
fi
