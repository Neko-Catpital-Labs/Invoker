#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${INVOKER_REPO_CONFIG_PATH:-$HOME/.invoker/config.json}"
TARGET_ID="${SESSION_TOKEN_PUSH_TARGET:-remote_digital_ocean_1}"
REMOTE_DIR='~/.invoker/session-rollups'

if ! TARGET_FIELDS="$(CONFIG_PATH="$CONFIG_PATH" TARGET_ID="$TARGET_ID" node <<'NODE'
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
if (!fs.existsSync(configPath)) {
  process.exit(3);
}
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
)"; then
  echo "cron-session-token-push.sh: remote target '$TARGET_ID' not found or incomplete in $CONFIG_PATH" >&2
  exit 1
fi

IFS=$'\t' read -r TARGET_HOST TARGET_USER TARGET_PORT TARGET_KEY_PATH <<< "$TARGET_FIELDS"

SINCE="$(python3 -c 'import datetime; print((datetime.date.today() - datetime.timedelta(days=30)).isoformat())')"

LOCAL_TMP="$(mktemp)"
trap 'rm -f "$LOCAL_TMP"' EXIT

python3 "$REPO_ROOT/scripts/session-token-rollup.py" collect --since "$SINCE" --out "$LOCAL_TMP"

HOST_LABEL="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['host'])" "$LOCAL_TMP")"

REMOTE_TMP="${REMOTE_DIR}/${HOST_LABEL}.json.tmp"
REMOTE_FINAL="${REMOTE_DIR}/${HOST_LABEL}.json"

ssh -i "$TARGET_KEY_PATH" -p "$TARGET_PORT" -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
  "${TARGET_USER}@${TARGET_HOST}" "mkdir -p ${REMOTE_DIR}"

scp -i "$TARGET_KEY_PATH" -P "$TARGET_PORT" -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
  "$LOCAL_TMP" "${TARGET_USER}@${TARGET_HOST}:${REMOTE_TMP}"

ssh -i "$TARGET_KEY_PATH" -p "$TARGET_PORT" -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
  "${TARGET_USER}@${TARGET_HOST}" "mv ${REMOTE_TMP} ${REMOTE_FINAL}"
