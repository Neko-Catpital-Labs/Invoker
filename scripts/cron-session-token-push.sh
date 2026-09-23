#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${INVOKER_REPO_CONFIG_PATH:-$HOME/.invoker/config.json}"
TARGET_ID="${SESSION_TOKEN_PUSH_TARGET:-remote_digital_ocean_1}"
HOST_LABEL="${SESSION_TOKEN_PUSH_HOST_LABEL:-$(hostname)}"
REMOTE_DIR=".invoker/session-rollups"

if [[ -n "${SESSION_TOKEN_PUSH_SINCE:-}" ]]; then
  SINCE="$SESSION_TOKEN_PUSH_SINCE"
elif date -u -d '-30 days' +%Y-%m-%d >/dev/null 2>&1; then
  SINCE="$(date -u -d '-30 days' +%Y-%m-%d)"
else
  SINCE="$(date -u -v-30d +%Y-%m-%d)"
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "cron-session-token-push: config not found: $CONFIG_PATH" >&2
  exit 1
fi

set +e
TARGET_LINE="$(CONFIG_PATH="$CONFIG_PATH" TARGET_ID="$TARGET_ID" node <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

const configPath = expandHome(process.env.CONFIG_PATH);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const target = (config.remoteTargets || {})[process.env.TARGET_ID];
if (!target || typeof target !== 'object') {
  process.exit(3);
}
const host = String(target.host || '');
const user = String(target.user || '');
const keyPath = expandHome(String(target.sshKeyPath || ''));
const port = String(target.port || 22);
if (!host || !user || !keyPath) {
  process.exit(3);
}
process.stdout.write([host, user, port, keyPath].join('\t'));
NODE
)"
NODE_EXIT=$?
set -e

if [[ "$NODE_EXIT" -ne 0 || -z "$TARGET_LINE" ]]; then
  echo "cron-session-token-push: remote target '$TARGET_ID' not found or incomplete in $CONFIG_PATH" >&2
  exit 1
fi

IFS=$'\t' read -r REMOTE_HOST REMOTE_USER REMOTE_PORT REMOTE_KEY_PATH <<< "$TARGET_LINE"

LOCAL_REPORT="$(mktemp "${TMPDIR:-/tmp}/session-token-push.XXXXXX.json")"
trap 'rm -f "$LOCAL_REPORT"' EXIT

python3 "$REPO_ROOT/scripts/session-token-rollup.py" collect --since "$SINCE" --host "$HOST_LABEL" --out "$LOCAL_REPORT"

REMOTE_FINAL="${REMOTE_DIR}/${HOST_LABEL}.json"
REMOTE_TMP="${REMOTE_FINAL}.tmp"

ssh -i "$REMOTE_KEY_PATH" -p "$REMOTE_PORT" -o BatchMode=yes -o ConnectTimeout=30 \
  "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p ${REMOTE_DIR}"

scp -i "$REMOTE_KEY_PATH" -P "$REMOTE_PORT" -o BatchMode=yes -o ConnectTimeout=30 \
  "$LOCAL_REPORT" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_TMP}"

ssh -i "$REMOTE_KEY_PATH" -p "$REMOTE_PORT" -o BatchMode=yes -o ConnectTimeout=30 \
  "${REMOTE_USER}@${REMOTE_HOST}" "mv ${REMOTE_TMP} ${REMOTE_FINAL}"

echo "cron-session-token-push: pushed ${HOST_LABEL}.json to ${TARGET_ID} (${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_FINAL})"
