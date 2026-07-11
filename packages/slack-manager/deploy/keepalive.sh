#!/usr/bin/env bash
# Fallback supervisor for hosts without systemd. Restarts the Slack manager if it
# exits. Installed by install.sh as an @reboot cron job wrapped in setsid.
#
#   @reboot setsid /path/to/keepalive.sh >> ~/.invoker/slack-manager.keepalive.log 2>&1
set -u

REPO_ROOT="${INVOKER_REPO_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
SLACK_BIN="${INVOKER_SLACK_BIN:-$(command -v invoker-slack || true)}"
ENV_FILE="${INVOKER_SLACK_OWNER_ENV:-$HOME/.invoker/.slack-owner.env}"
RESTART_DELAY="${RESTART_DELAY:-5}"

cd "$REPO_ROOT" || exit 1
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

while true; do
  echo "[keepalive] $(date -Is) starting slack-manager"
  if [ -n "$SLACK_BIN" ] && [ -x "$SLACK_BIN" ]; then
    "$SLACK_BIN"
  else
    "$NODE_BIN" packages/slack-manager/dist/index.js
  fi
  echo "[keepalive] $(date -Is) slack-manager exited ($?); restarting in ${RESTART_DELAY}s"
  sleep "$RESTART_DELAY"
done
