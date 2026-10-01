#!/bin/sh
# Build and launch the Invoker Electron app (GUI mode).
# Also used for headless mode: ./run.sh --headless run <plan.yaml>

if [ "${INVOKER_RUN_SH_BASH_ACTIVE:-0}" != "1" ]; then
  if [ "${1:-}" = "--headless" ] \
    && { [ "${2:-}" = "--no-track" ] || [ "${2:-}" = "--do-not-track" ]; } \
    && [ "${3:-}" = "run" ]; then
    _ipc_plan_path="${4:-}"
    _ipc_home="${INVOKER_DB_DIR:-$HOME/.invoker}"
    _ipc_intake_dir="$_ipc_home/headless-run-intake.d"
    if [ -d "$_ipc_intake_dir" ]; then
      case "$_ipc_plan_path" in
        /*) ;;
        *)
          case "$0" in
            /*) _ipc_plan_path="${0%/*}/$_ipc_plan_path" ;;
          esac
          ;;
      esac
      printf '%s\n' "$_ipc_plan_path" > "$_ipc_intake_dir/$$.item"
      exit 0
    fi
    _ipc_intake_ready="$_ipc_home/headless-run-intake.ready"
    _ipc_intake_log="$_ipc_home/headless-run-intake.log"
    if [ -f "$_ipc_intake_ready" ]; then
      case "$_ipc_plan_path" in
        /*) ;;
        *)
          case "$0" in
            /*) _ipc_plan_path="${0%/*}/$_ipc_plan_path" ;;
          esac
          ;;
      esac
      printf '%s\n' "$_ipc_plan_path" >> "$_ipc_intake_log"
      exit 0
    fi
  fi

  case "$0" in
    /*) _fast_repo_root="${0%/*}" ;;
    *) _fast_repo_root="" ;;
  esac

  if [ -n "$_fast_repo_root" ] \
    && [ "${1:-}" = "--headless" ] \
    && { [ "${2:-}" = "--no-track" ] || [ "${2:-}" = "--do-not-track" ]; } \
    && [ "${3:-}" = "run" ] \
    && [ -n "${INVOKER_IPC_SOCKET:-}" ] \
    && [ -S "${INVOKER_IPC_SOCKET:-}" ] \
    && command -v perl >/dev/null 2>&1; then
    _ipc_plan_path="${4:-}"
    case "$_ipc_plan_path" in
      /*) ;;
      *) _ipc_plan_path="$_fast_repo_root/$_ipc_plan_path" ;;
    esac
    _ipc_fifo="${INVOKER_DB_DIR:-$HOME/.invoker}/headless-run.fifo"
    if [ -p "$_ipc_fifo" ]; then
      printf '%s\n' "$_ipc_plan_path" > "$_ipc_fifo"
      echo "--no-track enabled: delegated submission accepted; exiting without tracking."
      exit 0
    fi
    _ipc_queue_root="${INVOKER_DB_DIR:-$HOME/.invoker}/headless-run-queue"
    _ipc_queue_lock="${_ipc_queue_root}.lock"
    [ -d "$_ipc_queue_root" ] || mkdir -p "$_ipc_queue_root"
    _ipc_item="$_ipc_queue_root/$$.item"
    printf '%s\n' "$_ipc_plan_path" > "$_ipc_item"
    if ( set -C; : > "$_ipc_queue_lock" ) 2>/dev/null; then
      perl "$_fast_repo_root/scripts/headless-run-ipc.pl" --drain-queue "$_ipc_queue_root" "$_ipc_queue_lock" >/dev/null 2>>"${INVOKER_DB_DIR:-$HOME/.invoker}/headless-run-ipc.err" &
    fi
    echo "--no-track enabled: delegated submission accepted; exiting without tracking."
    exit 0
  fi

  if [ "${1:-}" = "--headless" ] \
    && [ "${2:-}" = "query" ] \
    && [ -n "${INVOKER_DB_DIR:-}" ]; then
    _ipc_intake_dir="${INVOKER_DB_DIR:-$HOME/.invoker}/headless-run-intake.d"
    for _ipc_wait in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 69 70 71 72 73 74 75 76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 91 92 93 94 95 96 97 98 99 100; do
      if [ -d "$_ipc_intake_dir" ] && ls "$_ipc_intake_dir"/*.item >/dev/null 2>&1; then
        sleep 0.05
      else
        break
      fi
    done
    _ipc_intake_log="${INVOKER_DB_DIR:-$HOME/.invoker}/headless-run-intake.log"
    _ipc_intake_offset="${INVOKER_DB_DIR:-$HOME/.invoker}/headless-run-intake.offset"
    for _ipc_wait in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 58 59 60 61 62 63 64 65 66 67 68 69 70 71 72 73 74 75 76 77 78 79 80 81 82 83 84 85 86 87 88 89 90 91 92 93 94 95 96 97 98 99 100; do
      if [ -f "$_ipc_intake_log" ] && [ -f "$_ipc_intake_offset" ]; then
        _ipc_intake_size=$(wc -c < "$_ipc_intake_log" 2>/dev/null | tr -d '[:space:]')
        _ipc_intake_size="${_ipc_intake_size:-0}"
        _ipc_intake_done=$(cat "$_ipc_intake_offset" 2>/dev/null || printf '0')
        if [ "${_ipc_intake_size:-0}" = "${_ipc_intake_done:-0}" ]; then
          break
        fi
        sleep 0.05
      else
        break
      fi
    done
    _ipc_queue_root="${INVOKER_DB_DIR:-$HOME/.invoker}/headless-run-queue"
    _ipc_queue_lock="${_ipc_queue_root}.lock"
    _ipc_wait=0
    while [ "$_ipc_wait" -lt 100 ]; do
      if ! ls "$_ipc_queue_root"/*.item >/dev/null 2>&1 && [ ! -e "$_ipc_queue_lock" ]; then
        break
      fi
      sleep 0.05
      _ipc_wait=$((_ipc_wait + 1))
    done
  fi

  INVOKER_RUN_SH_BASH_ACTIVE=1 exec bash "$0" "$@"
fi

set -e

_launcher_path="${BASH_SOURCE[0]:-$0}"
case "$_launcher_path" in
  /*) _fast_repo_root="${_launcher_path%/*}" ;;
  *) _fast_repo_root="" ;;
esac

if [ -n "$_fast_repo_root" ] \
  && [ "${1:-}" = "--headless" ] \
  && { [ "${2:-}" = "--no-track" ] || [ "${2:-}" = "--do-not-track" ]; } \
  && [ "${3:-}" = "run" ] \
  && [ -n "${INVOKER_IPC_SOCKET:-}" ] \
  && [ -S "${INVOKER_IPC_SOCKET:-}" ] \
  && command -v perl >/dev/null 2>&1; then
  _ipc_queue_root="${INVOKER_DB_DIR:-$HOME/.invoker}/headless-run-queue"
  _ipc_queue_lock="${_ipc_queue_root}.lock"
  [ -d "$_ipc_queue_root" ] || mkdir -p "$_ipc_queue_root"
  _ipc_stamp="${EPOCHREALTIME:-$SECONDS}"
  _ipc_stamp="${_ipc_stamp//[^0-9]/}"
  _ipc_item="$_ipc_queue_root/$_ipc_stamp-$$-$RANDOM.item"
  _ipc_plan_path="${4:-}"
  case "$_ipc_plan_path" in
    /*) ;;
    *) _ipc_plan_path="$_fast_repo_root/$_ipc_plan_path" ;;
  esac
  printf '%s\n' "$_ipc_plan_path" > "$_ipc_item"
  if ( set -o noclobber; : > "$_ipc_queue_lock" ) 2>/dev/null; then
    perl "$_fast_repo_root/scripts/headless-run-ipc.pl" --drain-queue "$_ipc_queue_root" "$_ipc_queue_lock" >/dev/null 2>>"${INVOKER_DB_DIR:-$HOME/.invoker}/headless-run-ipc.err" &
  fi
  echo "--no-track enabled: delegated submission accepted; exiting without tracking."
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

if [ "${1:-}" = "--headless" ] \
  && { [ "${2:-}" = "--no-track" ] || [ "${2:-}" = "--do-not-track" ]; } \
  && [ "${3:-}" = "run" ] \
  && [ -n "${INVOKER_IPC_SOCKET:-}" ] \
  && [ -S "${INVOKER_IPC_SOCKET:-}" ] \
  && command -v perl >/dev/null 2>&1; then
  _ipc_plan_path="${4:-}"
  case "$_ipc_plan_path" in
    /*) ;;
    *) _ipc_plan_path="$REPO_ROOT/$_ipc_plan_path" ;;
  esac
  _ipc_fifo="${INVOKER_DB_DIR:-$HOME/.invoker}/headless-run.fifo"
  if [ -p "$_ipc_fifo" ]; then
    printf '%s\n' "$_ipc_plan_path" > "$_ipc_fifo"
    exit 0
  fi
  _ipc_queue_root="${INVOKER_DB_DIR:-$HOME/.invoker}/headless-run-queue"
  _ipc_queue_lock="${_ipc_queue_root}.lock"
  [ -d "$_ipc_queue_root" ] || mkdir -p "$_ipc_queue_root"
  _ipc_stamp="${EPOCHREALTIME:-$SECONDS}"
  _ipc_stamp="${_ipc_stamp//[^0-9]/}"
  _ipc_item="$_ipc_queue_root/$_ipc_stamp-$$-$RANDOM.item"
  printf '%s\n' "$_ipc_plan_path" > "$_ipc_item"
  if ( set -o noclobber; : > "$_ipc_queue_lock" ) 2>/dev/null; then
    perl "$REPO_ROOT/scripts/headless-run-ipc.pl" --drain-queue "$_ipc_queue_root" "$_ipc_queue_lock" >/dev/null 2>>"${INVOKER_DB_DIR:-$HOME/.invoker}/headless-run-ipc.err" &
  fi
  echo "--no-track enabled: delegated submission accepted; exiting without tracking."
  exit 0
fi

if [ "${1:-}" = "--headless" ] \
  && [ "${2:-}" = "query" ] \
  && [ -n "${INVOKER_DB_DIR:-}" ]; then
  _ipc_queue_root="${INVOKER_DB_DIR:-$HOME/.invoker}/headless-run-queue"
  _ipc_queue_lock="${_ipc_queue_root}.lock"
  for _ipc_wait in {1..100}; do
    if ! ls "$_ipc_queue_root"/*.item >/dev/null 2>&1 && [ ! -e "$_ipc_queue_lock" ]; then
      break
    fi
    sleep 0.05
  done
fi

if [ "${INVOKER_DEVELOPMENT_PROFILE_ACTIVE:-0}" != "1" ]; then
  exec node "$REPO_ROOT/scripts/with-invoker-development-profile.mjs" -- bash "$0" "$@"
fi

# Workspaces are durable task/attempt artifacts. Disable destructive cleanup
# from this launcher even if the caller's environment opts into it.
export INVOKER_ENABLE_WORKSPACE_CLEANUP=0

BOOTSTRAP_STAMP="$REPO_ROOT/node_modules/.invoker-bootstrap-stamp"
WORKSPACE_INSTALL_METADATA="$REPO_ROOT/node_modules/.modules.yaml"
HEADLESS_MODE=0
if [ "${1:-}" = "--headless" ]; then
  HEADLESS_MODE=1
fi

has_bootstrap_artifacts() {
  [ -f "$WORKSPACE_INSTALL_METADATA" ] \
    && [ -x "$REPO_ROOT/packages/app/node_modules/.bin/electron" ]
}

bootstrap_tools_are_healthy() {
  "$REPO_ROOT/node_modules/.bin/tsup" --version >/dev/null 2>&1
}

# An existing install goes stale when the lockfile changes (e.g. a git pull
# adds a dependency) but node_modules is left untouched. The artifacts check
# above only proves *some* install exists, so without this check run.sh would
# skip the reinstall and then fail the build on the now-missing package. Use
# pnpm's workspace metadata as the durable freshness signal so preprovisioned
# installs do not need run.sh's private stamp.
workspace_install_is_stale() {
  [ ! -f "$WORKSPACE_INSTALL_METADATA" ] || [ "$REPO_ROOT/pnpm-lock.yaml" -nt "$WORKSPACE_INSTALL_METADATA" ]
}

ensure_workspace_bootstrapped() {
  if [ "${INVOKER_SKIP_BOOTSTRAP_CHECK:-0}" = "1" ]; then
    return 0
  fi

  if has_bootstrap_artifacts && ! workspace_install_is_stale && [ "${INVOKER_FORCE_BOOTSTRAP:-0}" != "1" ]; then
    if [ "$HEADLESS_MODE" = "1" ] && [ -f "$REPO_ROOT/packages/app/dist/headless-client.js" ]; then
      return 0
    fi
    if bootstrap_tools_are_healthy; then
      return 0
    fi
  fi

  echo "Bootstrapping workspace dependencies..." >&2
  pnpm install --frozen-lockfile >&2
  # Keep the historical launcher marker; freshness is based on pnpm metadata.
  touch "$BOOTSTRAP_STAMP"
}

# Ensure workspace dependencies are linked before building.
# Headless commands must keep stdout clean because scripts parse labels/JSON.
ensure_workspace_bootstrapped

# Unset ELECTRON_RUN_AS_NODE so Electron loads its full API.
unset ELECTRON_RUN_AS_NODE

# In headless mode, validate config fast (before any build) and then ensure dist exists.
if [ "$1" = "--headless" ]; then
  # Fast-path config validation in bash so malformed JSON fails immediately
  # without waiting for a dist build.
  if [ ! -f "$REPO_ROOT/packages/app/dist/headless-client.js" ]; then
    _cfg_path="${INVOKER_REPO_CONFIG_PATH:-$HOME/.invoker/config.json}"
    if [ -f "$_cfg_path" ]; then
      if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$_cfg_path" 2>/dev/null; then
        echo "Invalid Invoker config JSON at $_cfg_path: malformed JSON" >&2
        exit 1
      fi
    fi
  fi
  if [ "${2:-}" = "retry-tasks" ]; then
    shift 2
    exec bash "$REPO_ROOT/scripts/retry-tasks-by-status.sh" "$@"
  fi

  if [ -n "${INVOKER_DB_DIR:-}" ]; then
    mkdir -p "${INVOKER_DB_DIR}/headless-run-queue" 2>/dev/null || true
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
  if { [ "${1:-}" = "--no-track" ] || [ "${1:-}" = "--do-not-track" ]; } \
    && [ "${2:-}" = "run" ] \
    && command -v perl >/dev/null 2>&1; then
    set +e
    perl "$REPO_ROOT/scripts/headless-run-ipc.pl" "$@"
    _ipc_status=$?
    set -e
    if [ "$_ipc_status" -eq 0 ]; then
      exit 0
    fi
    if [ "$_ipc_status" -ne 86 ]; then
      exit "$_ipc_status"
    fi
  fi
  exec node ./packages/app/dist/headless-client.js "$@"
fi

# Kill any orphaned Puppeteer/automation Chrome left behind by crashed browser
# sessions, then clear stale Electron/tsup processes so we always start from a
# clean state.
if ! node ./scripts/cleanup-orphaned-automation-chrome.mjs; then
  echo "WARN: orphaned automation Chrome cleanup failed; continuing launch" >&2
fi
bash "$REPO_ROOT/scripts/cleanup-local-invoker-processes.sh"
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
