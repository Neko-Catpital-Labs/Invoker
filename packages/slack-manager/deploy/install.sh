#!/usr/bin/env bash
# Install the Invoker Slack manager as an independently-supervised daemon.
#
# Prefers a packaged `invoker-slack` on PATH (npm SEA binary). Falls back to
# building and running packages/slack-manager/dist/index.js from a monorepo
# checkout when the binary is not installed.
#
# Prereqs:
#   - Slack owner credentials at ~/.invoker/.slack-owner.env with:
#       SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, SLACK_CHANNEL_ID
#       (optionally SLACK_LOBBY_CHANNEL_ID, CURSOR_COMMAND, CURSOR_MODEL,
#        INVOKER_REPO_URL, INVOKER_DEFAULT_BRANCH)
#   - `cursor` / `omp` on PATH (the planner subprocess)
#
# Uses systemd --user when available (Restart=always + linger survives reboots),
# else falls back to an @reboot cron keepalive loop.
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || true)"
NODE_BIN="$(command -v node)"
SERVICE_SRC="${REPO_ROOT:+$REPO_ROOT/packages/slack-manager/deploy/slack-manager.service}"
ENV_FILE="$HOME/.invoker/.slack-owner.env"
SLACK_BIN="$(command -v invoker-slack || true)"

if [ -z "$NODE_BIN" ]; then echo "node not found on PATH" >&2; exit 1; fi
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — create it with SLACK_BOT_TOKEN/APP_TOKEN/SIGNING_SECRET/CHANNEL_ID first." >&2
  exit 1
fi

if [ -z "$SLACK_BIN" ]; then
  if [ -z "$REPO_ROOT" ] || [ ! -f "$REPO_ROOT/packages/slack-manager/package.json" ]; then
    echo "invoker-slack not on PATH and no monorepo checkout found." >&2
    echo "Install with: npm i -g @neko-catpital-labs/invoker-slack" >&2
    exit 1
  fi
  echo "Building @invoker/slack-manager (dev fallback)…"
  ( cd "$REPO_ROOT" && pnpm --filter @invoker/slack-manager build )
  EXEC_START="$NODE_BIN $REPO_ROOT/packages/slack-manager/dist/index.js"
  WORK_DIR="$REPO_ROOT"
else
  echo "Using packaged invoker-slack at $SLACK_BIN"
  EXEC_START="$SLACK_BIN"
  WORK_DIR="${REPO_ROOT:-$HOME}"
fi

if command -v systemctl >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  if [ -n "$SERVICE_SRC" ] && [ -f "$SERVICE_SRC" ]; then
    sed -e "s#__REPO_ROOT__#$WORK_DIR#g" \
        -e "s#__NODE__#$NODE_BIN#g" \
        -e "s#ExecStart=.*#ExecStart=$EXEC_START#g" \
      "$SERVICE_SRC" > "$UNIT_DIR/slack-manager.service"
  else
    cat > "$UNIT_DIR/slack-manager.service" <<EOF
[Unit]
Description=Invoker Slack manager (out-of-process Slack surface)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$WORK_DIR
EnvironmentFile=%h/.invoker/.slack-owner.env
ExecStart=$EXEC_START
Restart=always
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
  fi
  systemctl --user daemon-reload
  systemctl --user enable --now slack-manager.service
  loginctl enable-linger "$USER" || true
  echo "Installed. Logs: journalctl --user -u slack-manager -f"
else
  echo "systemd not available — installing @reboot cron keepalive fallback."
  if [ -z "$REPO_ROOT" ]; then
    echo "Cron keepalive needs the monorepo keepalive.sh; install systemd or clone the repo." >&2
    exit 1
  fi
  KEEPALIVE="$REPO_ROOT/packages/slack-manager/deploy/keepalive.sh"
  chmod +x "$KEEPALIVE"
  LINE="@reboot INVOKER_REPO_ROOT=$REPO_ROOT NODE_BIN=$NODE_BIN INVOKER_SLACK_BIN=${SLACK_BIN:-} setsid $KEEPALIVE >> $HOME/.invoker/slack-manager.keepalive.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v 'slack-manager/deploy/keepalive.sh' || true; echo "$LINE" ) | crontab -
  echo "Installed cron keepalive. Starting now…"
  INVOKER_REPO_ROOT="$REPO_ROOT" NODE_BIN="$NODE_BIN" INVOKER_SLACK_BIN="${SLACK_BIN:-}" \
    setsid "$KEEPALIVE" >> "$HOME/.invoker/slack-manager.keepalive.log" 2>&1 &
  echo "Logs: $HOME/.invoker/slack-manager.keepalive.log"
fi
