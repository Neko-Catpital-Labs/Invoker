#!/usr/bin/env bash
# Install the Invoker Slack manager as an independently-supervised daemon.
#
# Prereqs:
#   - Slack owner credentials at ~/.invoker/.slack-owner.env with:
#       SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, SLACK_CHANNEL_ID
#       (optionally SLACK_LOBBY_CHANNEL_ID, CURSOR_COMMAND, CURSOR_MODEL,
#        INVOKER_REPO_URL, INVOKER_DEFAULT_BRANCH)
#   - `cursor` / `omp` on PATH (the planner subprocess), `xvfb-run` for the GUI.
#
# Uses systemd --user when available (Restart=always + linger survives reboots),
# else falls back to an @reboot cron keepalive loop.
set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
NODE_BIN="$(command -v node)"
SERVICE_SRC="$REPO_ROOT/packages/slack-manager/deploy/slack-manager.service"
ENV_FILE="$HOME/.invoker/.slack-owner.env"

if [ -z "$NODE_BIN" ]; then echo "node not found on PATH" >&2; exit 1; fi
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — create it with SLACK_BOT_TOKEN/APP_TOKEN/SIGNING_SECRET/CHANNEL_ID first." >&2
  exit 1
fi

echo "Building @invoker/slack-manager…"
( cd "$REPO_ROOT" && pnpm --filter @invoker/slack-manager build )

if command -v systemctl >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  sed -e "s#__REPO_ROOT__#$REPO_ROOT#g" -e "s#__NODE__#$NODE_BIN#g" \
    "$SERVICE_SRC" > "$UNIT_DIR/slack-manager.service"
  systemctl --user daemon-reload
  systemctl --user enable --now slack-manager.service
  # Keep the user manager (and the service) alive across logout/reboot.
  loginctl enable-linger "$USER" || true
  echo "Installed. Logs: journalctl --user -u slack-manager -f"
else
  echo "systemd not available — installing @reboot cron keepalive fallback."
  KEEPALIVE="$REPO_ROOT/packages/slack-manager/deploy/keepalive.sh"
  chmod +x "$KEEPALIVE"
  LINE="@reboot INVOKER_REPO_ROOT=$REPO_ROOT NODE_BIN=$NODE_BIN setsid $KEEPALIVE >> $HOME/.invoker/slack-manager.keepalive.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v 'slack-manager/deploy/keepalive.sh' || true; echo "$LINE" ) | crontab -
  echo "Installed cron keepalive. Starting now…"
  INVOKER_REPO_ROOT="$REPO_ROOT" NODE_BIN="$NODE_BIN" setsid "$KEEPALIVE" >> "$HOME/.invoker/slack-manager.keepalive.log" 2>&1 &
  echo "Logs: $HOME/.invoker/slack-manager.keepalive.log"
fi
