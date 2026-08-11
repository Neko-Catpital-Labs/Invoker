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

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || true)"
NODE_BIN="$(command -v node)"
SERVICE_SRC="${REPO_ROOT:+$REPO_ROOT/packages/watcher/deploy/watcher.service}"
WATCHER_BIN="$(command -v invoker-watcher || true)"

if [ -z "$NODE_BIN" ]; then echo "node not found on PATH" >&2; exit 1; fi

if [ -z "$WATCHER_BIN" ]; then
  if [ -z "$REPO_ROOT" ] || [ ! -f "$REPO_ROOT/packages/watcher/package.json" ]; then
    echo "invoker-watcher not on PATH and no monorepo checkout found." >&2
    echo "Install with: npm i -g @neko-catpital-labs/invoker-watcher" >&2
    exit 1
  fi
  echo "Building @invoker/watcher (dev fallback)..."
  ( cd "$REPO_ROOT" && pnpm --filter @invoker/watcher build )
  EXEC_START="$NODE_BIN $REPO_ROOT/packages/watcher/dist/index.js"
  WORK_DIR="$REPO_ROOT"
else
  echo "Using packaged invoker-watcher at $WATCHER_BIN"
  EXEC_START="$WATCHER_BIN"
  WORK_DIR="${REPO_ROOT:-$HOME}"
fi

if command -v systemctl >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT_NAME="invoker-watcher.service"
  mkdir -p "$UNIT_DIR"
  if [ -n "$SERVICE_SRC" ] && [ -f "$SERVICE_SRC" ]; then
    sed -e "s#__REPO_ROOT__#$WORK_DIR#g" \
        -e "s#__NODE__#$NODE_BIN#g" \
        -e "s#ExecStart=.*#ExecStart=$EXEC_START#g" \
      "$SERVICE_SRC" > "$UNIT_DIR/$UNIT_NAME"
  else
    cat > "$UNIT_DIR/$UNIT_NAME" <<EOF
[Unit]
Description=Invoker watcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$WORK_DIR
ExecStart=$EXEC_START
Restart=always
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
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
  LINE="@reboot cd $REPO_ROOT && while true; do $EXEC_START >> $HOME/.invoker/watcher.keepalive.log 2>&1; sleep 5; done"
  ( crontab -l 2>/dev/null | grep -v 'watcher.keepalive.log' || true; echo "$LINE" ) | crontab -
  echo "Installed cron keepalive. Starting now..."
  ( cd "$REPO_ROOT" && while true; do $EXEC_START >> "$HOME/.invoker/watcher.keepalive.log" 2>&1; sleep 5; done ) &
  echo "Logs: $HOME/.invoker/watcher.keepalive.log"
fi
