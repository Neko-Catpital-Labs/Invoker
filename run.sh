#!/usr/bin/env bash
# Build and launch the Invoker Electron app (GUI mode).
# Also used for headless mode: ./run.sh --headless run <plan.yaml>
set -e
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

# Workspaces are durable task/attempt artifacts. Disable destructive cleanup
# from this launcher even if the caller's environment opts into it.
export INVOKER_ENABLE_WORKSPACE_CLEANUP=0

BOOTSTRAP_STAMP="$REPO_ROOT/node_modules/.invoker-bootstrap-stamp"

has_bootstrap_artifacts() {
  [ -f "$REPO_ROOT/node_modules/.modules.yaml" ] \
    && [ -x "$REPO_ROOT/packages/app/node_modules/.bin/electron" ]
}

bootstrap_tools_are_healthy() {
  "$REPO_ROOT/node_modules/.bin/tsup" --version >/dev/null 2>&1
}

# An existing install goes stale when the lockfile changes (e.g. a git pull
# adds a dependency) but node_modules is left untouched. The artifacts check
# above only proves *some* install exists, so without this check run.sh would
# skip the reinstall and then fail the build on the now-missing package. Treat
# the install as stale when we have no record of it, or when pnpm-lock.yaml is
# newer than the stamp written after the last successful install.
workspace_install_is_stale() {
  [ ! -f "$BOOTSTRAP_STAMP" ] || [ "$REPO_ROOT/pnpm-lock.yaml" -nt "$BOOTSTRAP_STAMP" ]
}

ensure_workspace_bootstrapped() {
  if has_bootstrap_artifacts && bootstrap_tools_are_healthy && ! workspace_install_is_stale && [ "${INVOKER_FORCE_BOOTSTRAP:-0}" != "1" ]; then
    return 0
  fi

  echo "Bootstrapping workspace dependencies..." >&2
  pnpm install --frozen-lockfile >&2
  touch "$BOOTSTRAP_STAMP"
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

# In headless mode, validate config fast (before any build) and then ensure dist exists.
if [ "$1" = "--headless" ]; then
  # Fast-path config validation in bash so malformed JSON fails immediately
  # without waiting for a dist build.
  _cfg_path="${INVOKER_REPO_CONFIG_PATH:-$HOME/.invoker/config.json}"
  if [ -f "$_cfg_path" ]; then
    if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$_cfg_path" 2>/dev/null; then
      echo "Invalid Invoker config JSON at $_cfg_path: malformed JSON" >&2
      exit 1
    fi
  fi
  if [ "${2:-}" = "retry-tasks" ]; then
    shift 2
    exec bash "$REPO_ROOT/scripts/retry-tasks-by-status.sh" "$@"
  fi

  # Build app and dependencies if headless entry point is missing (e.g. fresh worktree).
  if [ ! -f "$REPO_ROOT/packages/app/dist/headless-client.js" ]; then
    pnpm --filter @invoker/core build >&2
    pnpm --filter @invoker/persistence build >&2
    pnpm --filter @invoker/execution-engine build >&2
    pnpm --filter @invoker/surfaces build >&2
    pnpm --filter @invoker/ui build >&2
    pnpm --filter @invoker/app build >&2
  fi

  shift
  # Build @invoker/app on-demand when dist/headless-client.js is missing
  # (e.g. fresh worktree that only ran pnpm install).
  if [ ! -f "$REPO_ROOT/packages/app/dist/headless-client.js" ]; then
    echo "Building @invoker/app (headless-client.js missing)..." >&2
    pnpm --filter @invoker/app build >&2
  fi
  exec node ./packages/app/dist/headless-client.js "$@"
fi

# Kill any orphaned Puppeteer/automation Chrome left behind by crashed browser
# sessions, then clear stale Electron/tsup processes so we always start from a
# clean state.
if ! node ./scripts/cleanup-orphaned-automation-chrome.mjs; then
  echo "WARN: orphaned automation Chrome cleanup failed; continuing launch" >&2
fi
pkill -f "electron.*packages/app/dist/main.js" 2>/dev/null || true
pkill -f "tsup.*packages/app" 2>/dev/null || true
sleep 0.2

# Clean build all packages (tsup.config has clean: true)
pnpm --filter @invoker/core build
pnpm --filter @invoker/persistence build
pnpm --filter @invoker/execution-engine build
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
  DESKTOP_FILE_PATH="$(./scripts/install-linux-desktop-entry.sh)"
  export BAMF_DESKTOP_FILE_HINT="$DESKTOP_FILE_PATH"
  export CHROME_DESKTOP="$(basename "$DESKTOP_FILE_PATH")"
fi

if [ "$(uname)" = "Linux" ] && [ -z "${DISPLAY:-}" ]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "ERROR: GUI launch requires Xvfb when DISPLAY is not set." >&2
    echo "Install xvfb-run or set DISPLAY to an available X server." >&2
    exit 1
  fi
  ELECTRON_ENABLE_LOGGING=1 exec xvfb-run --auto-servernum \
    ./scripts/electron.cjs packages/app/dist/main.js $SANDBOX_FLAG "$@"
fi

ELECTRON_ENABLE_LOGGING=1 exec ./scripts/electron.cjs packages/app/dist/main.js $SANDBOX_FLAG "$@"
