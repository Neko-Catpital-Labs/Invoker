#!/usr/bin/env bash
# Build and launch the Invoker Electron app (GUI mode).
# Also used for headless mode: ./run.sh --headless run <plan.yaml>
set -e
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

thin_ipc_early_no_track_run() {
  local saw_headless=0
  local saw_no_track=0
  local positional_count=0
  local command_word=""
  local arg
  for arg in "$@"; do
    case "$arg" in
      --headless) saw_headless=1 ;;
      --no-track) saw_no_track=1 ;;
      --wait-for-approval) ;;
      -*) return 1 ;;
      *)
        positional_count=$((positional_count + 1))
        if [ "$positional_count" = "1" ]; then command_word="$arg"; fi
        ;;
    esac
  done
  [ "$saw_headless" = "1" ] && [ "$saw_no_track" = "1" ] && [ "$command_word" = "run" ] && [ "$positional_count" = "2" ]
}

thin_ipc_pending_dir() {
  [ -n "${INVOKER_DB_DIR:-}" ] || return 1
  printf '%s\n' "$INVOKER_DB_DIR/thin-intake-pending"
}

thin_ipc_plan_arg() {
  local positional_count=0
  local arg
  for arg in "$@"; do
    case "$arg" in
      --headless|--no-track|--wait-for-approval) ;;
      -* ) return 1 ;;
      *)
        positional_count=$((positional_count + 1))
        if [ "$positional_count" = "2" ]; then
          printf '%s\n' "$arg"
          return 0
        fi
        ;;
    esac
  done
  return 1
}

start_thin_ipc_queue_drainer() {
  local pending_dir="$1"
  local lock_dir="$pending_dir/worker.lock"
  local lock_pid_file="$lock_dir/pid"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    local lock_pid=""
    if [ -f "$lock_pid_file" ]; then
      lock_pid="$(cat "$lock_pid_file" 2>/dev/null || true)"
    fi
    case "$lock_pid" in
      ''|*[!0-9]*)
        ;;
      *)
        if kill -0 "$lock_pid" 2>/dev/null; then
          return 0
        fi
        ;;
    esac
    rm -f "$lock_pid_file" 2>/dev/null || true
    rmdir "$lock_dir" 2>/dev/null || return 0
    if ! mkdir "$lock_dir" 2>/dev/null; then
      return 0
    fi
  fi
  (
    printf '%s\n' "$BASHPID" >"$lock_pid_file"
    trap 'rm -f "$lock_pid_file" 2>/dev/null || true; rmdir "$lock_dir" 2>/dev/null || true' EXIT
    while true; do
      PENDING_FILE="$(find "$pending_dir" -name '*.pending' -type f -print -quit 2>/dev/null || true)"
      [ -n "$PENDING_FILE" ] || break
      PLAN_PATH="$(cat "$PENDING_FILE" 2>/dev/null || true)"
      FAST_WORKFLOW_ID="$(basename "$PENDING_FILE" .pending)"
      STDOUT_FILE="$pending_dir/$FAST_WORKFLOW_ID.stdout"
      STDERR_FILE="$pending_dir/$FAST_WORKFLOW_ID.stderr"
      set +e
      INVOKER_DEVELOPMENT_PROFILE_ACTIVE=1 INVOKER_THIN_IPC_FORCE_SYNC_ACK=1 \
        node "$REPO_ROOT/packages/app/dist/headless-ipc-client.js" --headless --no-track run "$PLAN_PATH" >"$STDOUT_FILE" 2>"$STDERR_FILE"
      STATUS=$?
      set -e
      if [ "$STATUS" != "0" ]; then
        {
          echo "headless.run background intake failed workflow=\"$FAST_WORKFLOW_ID\" status=$STATUS planPath=\"$PLAN_PATH\""
          cat "$STDERR_FILE"
        } >>"$pending_dir/failures.log"
      fi
      rm -f "$PENDING_FILE" "$STDOUT_FILE" "$STDERR_FILE"
    done
  ) &
}

wait_for_thin_ipc_pending_intakes() {
  local pending_dir
  pending_dir="$(thin_ipc_pending_dir)" || return 0
  [ -d "$pending_dir" ] || return 0
  start_thin_ipc_queue_drainer "$pending_dir"
  local attempt
  for attempt in $(seq 1 600); do
    if ! find "$pending_dir" -name '*.pending' -print -quit 2>/dev/null | grep -q .; then
      return 0
    fi
    sleep 0.05
  done
  echo "Timed out waiting for background headless.run intakes to finish." >&2
  return 1
}

if thin_ipc_early_no_track_run "$@" \
  && [ -f "$REPO_ROOT/packages/app/dist/headless-ipc-client.js" ] \
  && [ -n "${INVOKER_DB_DIR:-}" ] \
  && [ -f "$INVOKER_DB_DIR/invoker.db.owner" ]; then
  OWNER_PID="$(cat "$INVOKER_DB_DIR/invoker.db.owner" 2>/dev/null || true)"
  if [ -n "$OWNER_PID" ] && kill -0 "$OWNER_PID" 2>/dev/null; then
    PENDING_DIR="$(thin_ipc_pending_dir)"
    mkdir -p "$PENDING_DIR"
    FAST_WORKFLOW_ID="wf-thin-$$-$RANDOM-$RANDOM"
    PENDING_FILE="$PENDING_DIR/$FAST_WORKFLOW_ID.pending"
    PLAN_PATH="$(thin_ipc_plan_arg "$@")"
    printf '%s\n' "$PLAN_PATH" >"$PENDING_FILE"
    echo "Workflow ID: $FAST_WORKFLOW_ID"
    exit 0
  fi
fi

if [ "${1:-}" = "--headless" ] && ! thin_ipc_early_no_track_run "$@"; then
  wait_for_thin_ipc_pending_intakes
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

thin_ipc_client_handles_no_track_run() {
  local saw_no_track=0
  local positional_count=0
  local command_word=""
  local arg
  for arg in "$@"; do
    case "$arg" in
      --no-track) saw_no_track=1 ;;
      --headless|--wait-for-approval) ;;
      -*) return 1 ;;
      *)
        positional_count=$((positional_count + 1))
        if [ "$positional_count" = "1" ]; then command_word="$arg"; fi
        ;;
    esac
  done
  [ "$saw_no_track" = "1" ] && [ "$command_word" = "run" ] && [ "$positional_count" = "2" ]
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
  if thin_ipc_client_handles_no_track_run "$@"; then
    if [ ! -f "$REPO_ROOT/packages/app/dist/headless-ipc-client.js" ]; then
      echo "Building @invoker/app (headless-ipc-client.js missing)..." >&2
      pnpm --filter @invoker/app build >&2
    fi
    THIN_IPC_STDOUT="$(mktemp "${TMPDIR:-/tmp}/invoker-thin-ipc-stdout.XXXXXX")"
    THIN_IPC_STDERR="$(mktemp "${TMPDIR:-/tmp}/invoker-thin-ipc-stderr.XXXXXX")"
    set +e
    node ./packages/app/dist/headless-ipc-client.js "$@" >"$THIN_IPC_STDOUT" 2>"$THIN_IPC_STDERR"
    THIN_IPC_STATUS=$?
    set -e
    THIN_IPC_PRINTED_WORKFLOW_ID=0
    if grep -Eq '^Workflow ID: [^[:space:]]+' "$THIN_IPC_STDOUT"; then
      THIN_IPC_PRINTED_WORKFLOW_ID=1
    fi
    THIN_IPC_NEVER_REACHED_OWNER=0
    if grep -q 'no reachable owner' "$THIN_IPC_STDERR"; then
      THIN_IPC_NEVER_REACHED_OWNER=1
    fi
    if [ "$THIN_IPC_PRINTED_WORKFLOW_ID" = "0" ] && [ ! -s "$THIN_IPC_STDOUT" ] && [ ! -s "$THIN_IPC_STDERR" ]; then
      THIN_IPC_NEVER_REACHED_OWNER=1
    fi
    cat "$THIN_IPC_STDOUT"
    cat "$THIN_IPC_STDERR" >&2
    rm -f "$THIN_IPC_STDOUT" "$THIN_IPC_STDERR"
    if [ "$THIN_IPC_STATUS" = "0" ] && [ "$THIN_IPC_PRINTED_WORKFLOW_ID" = "1" ]; then
      exit 0
    fi
    if [ "$THIN_IPC_NEVER_REACHED_OWNER" != "1" ]; then
      if [ "$THIN_IPC_STATUS" = "0" ]; then
        echo "Error: thin IPC --no-track run exited 0 without printing a workflow id; refusing to report success." >&2
        exit 1
      fi
      exit "$THIN_IPC_STATUS"
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
