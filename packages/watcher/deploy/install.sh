#!/usr/bin/env bash
# Install the Invoker watcher as an independently-supervised daemon.
#
# Prefers a packaged `invoker-watcher` on PATH (npm SEA binary). Falls back to
# building and running packages/watcher/dist/index.js from a monorepo checkout
# when the binary is not installed.
#
# Uses systemd --user when available (Restart=always + linger survives reboots),
# else falls back to an @reboot cron keepalive loop.
set -euo pipefail

systemd_quote() {
  case "$1" in
    *$'\n'*|*$'\r'*)
      echo "systemd unit values cannot contain newlines: $1" >&2
      return 1
      ;;
  esac

  local value="${1//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

systemd_setting_value() {
  case "$1" in
    *$'\n'*|*$'\r'*)
      echo "systemd unit values cannot contain newlines: $1" >&2
      return 1
      ;;
  esac

  local value="${1//\\/\\\\}"
  value="${value//%/%%}"
  printf '%s' "$value"
}

systemd_exec_start() {
  local output=""
  local arg
  for arg in "$@"; do
    if [ -n "$output" ]; then
      output+=" "
    fi
    output+="$(systemd_quote "$arg")"
  done
  printf '%s\n' "$output"
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

shell_command_line() {
  local output=""
  local arg
  for arg in "$@"; do
    if [ -n "$output" ]; then
      output+=" "
    fi
    output+="$(shell_quote "$arg")"
  done
  printf '%s\n' "$output"
}

render_systemd_unit() {
  local work_dir="$1"
  shift

  local escaped_work_dir
  escaped_work_dir="$(systemd_setting_value "$work_dir")"
  local escaped_exec_start
  escaped_exec_start="$(systemd_exec_start "$@")"

  cat <<EOF
[Unit]
Description=Invoker watcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$escaped_work_dir
ExecStart=$escaped_exec_start
Restart=always
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
}

render_systemd_template() {
  local template="$1"
  local work_dir="$2"
  shift 2

  local escaped_work_dir
  escaped_work_dir="$(systemd_setting_value "$work_dir")"
  local escaped_exec_start
  escaped_exec_start="$(systemd_exec_start "$@")"

  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "WorkingDirectory=__REPO_ROOT__")
        printf 'WorkingDirectory=%s\n' "$escaped_work_dir"
        ;;
      ExecStart=*)
        printf 'ExecStart=%s\n' "$escaped_exec_start"
        ;;
      *)
        printf '%s\n' "$line"
        ;;
    esac
  done < "$template"
}

main() {
REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || true)"
SERVICE_SRC="${REPO_ROOT:+$REPO_ROOT/packages/watcher/deploy/watcher.service}"
WATCHER_BIN="$(command -v invoker-watcher || true)"

declare -a EXEC_START

if [ -z "$WATCHER_BIN" ]; then
  if [ -z "$REPO_ROOT" ] || [ ! -f "$REPO_ROOT/packages/watcher/package.json" ]; then
    echo "invoker-watcher not on PATH and no monorepo checkout found." >&2
    echo "Install with: npm i -g @neko-catpital-labs/invoker-watcher" >&2
    exit 1
  fi
  NODE_BIN="$(command -v node || true)"
  if [ -z "$NODE_BIN" ]; then echo "node not found on PATH" >&2; exit 1; fi
  echo "Building @invoker/watcher (dev fallback)..."
  ( cd "$REPO_ROOT" && pnpm --filter @invoker/watcher build )
  EXEC_START=( "$NODE_BIN" "$REPO_ROOT/packages/watcher/dist/index.js" )
  WORK_DIR="$REPO_ROOT"
else
  echo "Using packaged invoker-watcher at $WATCHER_BIN"
  EXEC_START=( "$WATCHER_BIN" )
  WORK_DIR="${REPO_ROOT:-$HOME}"
fi

if command -v systemctl >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT_NAME="invoker-watcher.service"
  mkdir -p "$UNIT_DIR"
  if [ -n "$SERVICE_SRC" ] && [ -f "$SERVICE_SRC" ]; then
    render_systemd_template "$SERVICE_SRC" "$WORK_DIR" "${EXEC_START[@]}" > "$UNIT_DIR/$UNIT_NAME"
  else
    render_systemd_unit "$WORK_DIR" "${EXEC_START[@]}" > "$UNIT_DIR/$UNIT_NAME"
  fi
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME"
  loginctl enable-linger "$USER" || true
  echo "Installed. Logs: journalctl --user -u invoker-watcher -f"
else
  echo "systemd not available - installing @reboot cron keepalive fallback."
  if [ -z "$REPO_ROOT" ]; then
    echo "Cron keepalive needs a monorepo checkout; install systemd or clone the repo." >&2
    exit 1
  fi
  LOG_FILE="$HOME/.invoker/watcher.keepalive.log"
  LINE="@reboot cd $(shell_quote "$REPO_ROOT") && while true; do $(shell_command_line "${EXEC_START[@]}") >> $(shell_quote "$LOG_FILE") 2>&1; sleep 5; done"
  ( crontab -l 2>/dev/null | grep -v 'watcher.keepalive.log' || true; echo "$LINE" ) | crontab -
  echo "Installed cron keepalive. Starting now..."
  ( cd "$REPO_ROOT" && while true; do "${EXEC_START[@]}" >> "$LOG_FILE" 2>&1; sleep 5; done ) &
  echo "Logs: $LOG_FILE"
fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
