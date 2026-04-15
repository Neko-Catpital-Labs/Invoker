#!/usr/bin/env bash
# Build and launch the Invoker Electron app (GUI mode).
# Also used for headless mode: ./run.sh --headless run <plan.yaml>
set -e
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

has_bootstrap_artifacts() {
  [ -f "$REPO_ROOT/node_modules/.modules.yaml" ] \
    && [ -x "$REPO_ROOT/packages/app/node_modules/.bin/electron" ]
}

ensure_workspace_bootstrapped() {
  if has_bootstrap_artifacts && [ "${INVOKER_FORCE_BOOTSTRAP:-0}" != "1" ]; then
    return 0
  fi

  echo "Bootstrapping workspace dependencies..." >&2
  pnpm install --frozen-lockfile >&2
}

expand_home_path() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s\n' "$HOME/${1#~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

normalize_path() {
  local raw="$1"
  local expanded
  expanded="$(expand_home_path "$raw")"
  expanded="${expanded%/}"
  if [ -z "$expanded" ]; then
    expanded="/"
  fi

  if [ -d "$expanded" ]; then
    (cd "$expanded" && pwd -P)
    return
  fi

  local parent base
  parent="$(dirname "$expanded")"
  base="$(basename "$expanded")"
  if [ -d "$parent" ]; then
    printf '%s/%s\n' "$(cd "$parent" && pwd -P)" "$base"
  else
    printf '%s\n' "$expanded"
  fi
}

# Hard safety guard: never allow headless delete-all to target the default
# production DB unless explicitly overridden.
if [ "${1:-}" = "--headless" ] && [ "${2:-}" = "delete-all" ]; then
  DB_ROOT_RAW="${INVOKER_DB_DIR:-$HOME/.invoker}"
  DB_ROOT="$(normalize_path "$DB_ROOT_RAW")"
  PROD_ROOT="$(normalize_path "$HOME/.invoker")"

  if [ "${INVOKER_ALLOW_PRODUCTION_DELETE_ALL:-0}" != "1" ] && [ "$DB_ROOT" = "$PROD_ROOT" ]; then
    echo "ERROR: Refusing to run 'delete-all' against production DB root: $DB_ROOT" >&2
    echo "Set INVOKER_DB_DIR to an isolated temp directory for tests." >&2
    echo "Override only if intentional: INVOKER_ALLOW_PRODUCTION_DELETE_ALL=1" >&2
    exit 64
  fi
fi

# Ensure workspace dependencies are linked before building.
# Headless commands must keep stdout clean because scripts parse labels/JSON.
ensure_workspace_bootstrapped

# Unset ELECTRON_RUN_AS_NODE so Electron loads its full API.
unset ELECTRON_RUN_AS_NODE

# In headless mode (child of running app), skip cleanup and rebuild.
if [ "$1" = "--headless" ]; then
  shift
  exec node ./packages/app/dist/headless-client.js "$@"
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
