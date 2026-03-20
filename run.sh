#!/bin/bash
# Build and launch the Invoker Electron app (GUI mode).
# Also used for headless mode: ./run.sh --headless run <plan.yaml>
set -e
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

# Unset ELECTRON_RUN_AS_NODE so Electron loads its full API.
unset ELECTRON_RUN_AS_NODE

# In headless mode (child of running app), skip cleanup and rebuild.
if [ "$1" = "--headless" ]; then
  shift

  SANDBOX_FLAG=""
  if [ "$(uname)" = "Linux" ]; then
    SANDBOX_BIN="$REPO_ROOT/node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox"
    # shellcheck disable=SC2086
    if ! stat -c '%U:%a' $SANDBOX_BIN 2>/dev/null | grep -q '^root:4755$'; then
      SANDBOX_FLAG="--no-sandbox"
    fi
  fi

  unset ELECTRON_RUN_AS_NODE
  if [ "$(uname)" = "Linux" ]; then
    export LIBGL_ALWAYS_SOFTWARE=1
  fi
  exec ./packages/app/node_modules/.bin/electron packages/app/dist/main.js $SANDBOX_FLAG --headless "$@"
fi

# Kill any stale Electron/tsup processes from previous runs so we
# always start from a clean state.
pkill -f "electron.*packages/app/dist/main.js" 2>/dev/null || true
pkill -f "tsup.*packages/app" 2>/dev/null || true
sleep 0.2

# Clean build all packages (tsup.config has clean: true)
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

if [ "$(uname)" = "Linux" ]; then
  export LIBGL_ALWAYS_SOFTWARE=1
fi
ELECTRON_ENABLE_LOGGING=1 exec ./packages/app/node_modules/.bin/electron packages/app/dist/main.js $SANDBOX_FLAG "$@"
