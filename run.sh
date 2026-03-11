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

SANDBOX_FLAG=""
if [ "$(uname)" = "Linux" ]; then
  SANDBOX_BIN="$REPO_ROOT/node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox"
  # shellcheck disable=SC2086
  if ! stat -c '%U:%a' $SANDBOX_BIN 2>/dev/null | grep -q '^root:4755$'; then
    SANDBOX_FLAG="--no-sandbox"
  fi
fi

if [ "$1" = "--headless" ]; then
  shift
  ./packages/app/node_modules/.bin/electron packages/app/dist/main.js $SANDBOX_FLAG --headless "$@"
else
  ELECTRON_ENABLE_LOGGING=1 ./packages/app/node_modules/.bin/electron packages/app/dist/main.js $SANDBOX_FLAG "$@"
fi
