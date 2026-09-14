#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${INVOKER_DO1_CONFIG_PATH:-$HOME/.invoker/config.json}"
TARGET_ID="${INVOKER_DO1_TARGET_ID:-remote_digital_ocean_1}"
REMOTE_REPO_ROOT="${INVOKER_DO1_REPO_ROOT:-}"

[ -f "$CONFIG_PATH" ] || { echo "missing config: $CONFIG_PATH" >&2; exit 1; }

mapfile -t target < <(
  node - "$CONFIG_PATH" "$TARGET_ID" <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const [configPath, targetId] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const target = config.remoteTargets?.[targetId];
if (!target?.host || !target?.user || !target?.sshKeyPath) {
  throw new Error(`missing host, user, or sshKeyPath for remote target ${targetId}`);
}
const expandHome = (value) => value.startsWith('~/') ? `${os.homedir()}/${value.slice(2)}` : value;
console.log(target.host);
console.log(target.user);
console.log(expandHome(target.sshKeyPath));
NODE
)

[ "${#target[@]}" -eq 3 ] || { echo "failed to resolve DO1 target $TARGET_ID" >&2; exit 1; }
HOST="${target[0]}"
USER="${target[1]}"
KEY_PATH="${target[2]}"
REMOTE_REPO_ROOT="${REMOTE_REPO_ROOT:-/home/$USER/Invoker}"

[ -r "$KEY_PATH" ] || { echo "SSH key is not readable: $KEY_PATH" >&2; exit 1; }

ssh -i "$KEY_PATH" \
  -o StrictHostKeyChecking=accept-new \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  "$USER@$HOST" \
  bash -s -- "$REMOTE_REPO_ROOT" <<'REMOTE'
set -euo pipefail

REPO_ROOT="$1"
cd "$REPO_ROOT"

git fetch upstream master
git checkout master
git reset --hard upstream/master
TARGET_SHA="$(git rev-parse upstream/master)"
[ "$(git rev-parse HEAD)" = "$TARGET_SHA" ]

SURFACES_MTIME_BEFORE="$(stat -c %Y packages/surfaces/dist/index.js 2>/dev/null || printf 0)"

pnpm install --frozen-lockfile
bash scripts/required-builds.sh
pnpm --filter @invoker/ui build
pnpm --filter @invoker/app build
pnpm --filter @invoker/slack-manager build

PACKAGE_LOG="$(mktemp)"
if ! pnpm run dist:desktop:linux >"$PACKAGE_LOG" 2>&1 </dev/null; then
  cat "$PACKAGE_LOG" >&2
  rm -f "$PACKAGE_LOG"
  exit 1
fi
cat "$PACKAGE_LOG"
rm -f "$PACKAGE_LOG"
APP_VERSION="$(node -p "require('./packages/app/package.json').version")"
APPIMAGE_SRC="release/Invoker-${APP_VERSION}-x86_64.AppImage"
test -s "$APPIMAGE_SRC"

SURFACES_MTIME_AFTER="$(stat -c %Y packages/surfaces/dist/index.js)"
[ "$SURFACES_MTIME_AFTER" -gt "$SURFACES_MTIME_BEFORE" ] || {
  echo "surfaces dist was not rebuilt" >&2
  exit 1
}
test -s packages/surfaces/dist/index.js
# Old exclusive plan refusal — planning is allowed outside lobby now.
# Non-lobby restart/submit/workflow control messaging is still intentional.
stale="I only plan in the lobby channel (or DMs)"
if grep -qF "$stale" packages/surfaces/dist/index.js; then
  echo "stale channel refusal remains in surfaces dist: $stale" >&2
  exit 1
fi
grep -qF "[MENTION_ROUTE]" packages/surfaces/dist/index.js

pnpm run check:versions

NPM_GLOBAL_PLATFORM="$(node -p "process.platform")"
NPM_GLOBAL_ARCH="$(node -p "process.arch")"
CLI_VERSION="$(node -p "require('./packages/npm-cli/package.json').version")"
SLACK_VERSION="$(node -p "require('./packages/npm-slack/package.json').version")"
UI_VERSION="$(node -p "require('./packages/npm-ui/package.json').version")"

pnpm run dist:cli
pnpm run dist:slack

CLI_TARBALL_ASSET="release/invoker-cli-${CLI_VERSION}-${NPM_GLOBAL_PLATFORM}-${NPM_GLOBAL_ARCH}.tar.gz"
SLACK_TARBALL_ASSET="release/invoker-slack-${SLACK_VERSION}-${NPM_GLOBAL_PLATFORM}-${NPM_GLOBAL_ARCH}.tar.gz"
test -s "$CLI_TARBALL_ASSET"
test -s "$SLACK_TARBALL_ASSET"

NPM_ASSET_DIR="$(mktemp -d)"
cp "$APPIMAGE_SRC" "$NPM_ASSET_DIR/"
cp "$CLI_TARBALL_ASSET" "$NPM_ASSET_DIR/"
cp "$SLACK_TARBALL_ASSET" "$NPM_ASSET_DIR/"
bash scripts/release-sha256.sh "$NPM_ASSET_DIR/SHA256SUMS"

NPM_ASSET_PORT="$(python3 -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()')"
python3 -m http.server "$NPM_ASSET_PORT" --bind 127.0.0.1 --directory "$NPM_ASSET_DIR" >/tmp/deploy-do1-npm-asset-server.log 2>&1 &
NPM_ASSET_SERVER_PID=$!
trap 'kill "$NPM_ASSET_SERVER_PID" 2>/dev/null || true' EXIT

NPM_ASSET_SERVER_READY=0
for _ in $(seq 1 20); do
  if curl -sf "http://127.0.0.1:$NPM_ASSET_PORT/SHA256SUMS" >/dev/null 2>&1; then
    NPM_ASSET_SERVER_READY=1
    break
  fi
  sleep 0.3
done
[ "$NPM_ASSET_SERVER_READY" -eq 1 ] || {
  echo "local npm asset server never became ready on port $NPM_ASSET_PORT" >&2
  exit 1
}

NPM_PACK_DIR="$(mktemp -d)"
CLI_PACK_TARBALL="$(pnpm --filter @neko-catpital-labs/invoker-cli pack --pack-destination "$NPM_PACK_DIR" | tail -n 1)"
SLACK_PACK_TARBALL="$(pnpm --filter @neko-catpital-labs/invoker-slack pack --pack-destination "$NPM_PACK_DIR" | tail -n 1)"
UI_PACK_TARBALL_RAW="$(pnpm --filter @neko-catpital-labs/invoker-ui pack --pack-destination "$NPM_PACK_DIR" | tail -n 1)"
UI_PACK_TARBALL="$NPM_PACK_DIR/invoker-ui-pinned.tgz"
node scripts/pin-npm-ui-cli-dependency.mjs "$UI_PACK_TARBALL_RAW" "$CLI_PACK_TARBALL" "$UI_PACK_TARBALL"

INVOKER_RELEASE_BASE_URL="http://127.0.0.1:$NPM_ASSET_PORT" npm install -g "$CLI_PACK_TARBALL"
INVOKER_RELEASE_BASE_URL="http://127.0.0.1:$NPM_ASSET_PORT" npm install -g "$SLACK_PACK_TARBALL"
INVOKER_RELEASE_BASE_URL="http://127.0.0.1:$NPM_ASSET_PORT" npm install -g "$UI_PACK_TARBALL"

kill "$NPM_ASSET_SERVER_PID" 2>/dev/null || true
trap - EXIT
rm -rf "$NPM_ASSET_DIR" "$NPM_PACK_DIR"
echo "npm-global refresh complete: cli=$CLI_VERSION slack=$SLACK_VERSION ui=$UI_VERSION"

systemctl --user unmask slack-manager.service 2>/dev/null || true

LOG_FILE="$(mktemp)"
setsid bash -c '
  set -euo pipefail
  cd "'"$REPO_ROOT"'"
  APPIMAGE_DEST="packages/npm-ui/vendor/Invoker.AppImage"

  owner_is_up() {
    python3 - <<PY
import os
import sys

own_pgid = os.getpgid(os.getpid())
for name in os.listdir("/proc"):
    if not name.isdigit():
        continue
    pid = int(name)
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as proc:
            command = proc.read().replace(b"\0", b" ").decode(errors="replace")
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue
    if "--headless owner-serve" not in command:
        continue
    if os.getpgid(pid) == own_pgid:
        continue
    sys.exit(0)
sys.exit(1)
PY
  }

  systemctl --user stop slack-manager.service 2>/dev/null || true

  python3 - <<PY
import os
import signal

own_pgid = os.getpgid(os.getpid())
process_groups = set()
for name in os.listdir("/proc"):
    if not name.isdigit():
        continue
    pid = int(name)
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as proc:
            command = proc.read().replace(b"\0", b" ").decode(errors="replace")
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue
    if "--headless owner-serve" not in command:
        continue
    pgid = os.getpgid(pid)
    if pgid == own_pgid:
        continue
    process_groups.add(pgid)

for process_group in process_groups:
    try:
        os.killpg(process_group, signal.SIGTERM)
    except ProcessLookupError:
        pass
PY

  for pid in $(lsof -t "$APPIMAGE_DEST" 2>/dev/null || true); do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 10); do
    [ -z "$(lsof -t "$APPIMAGE_DEST" 2>/dev/null || true)" ] && break
    sleep 1
  done
  if [ -n "$(lsof -t "$APPIMAGE_DEST" 2>/dev/null || true)" ]; then
    lsof "$APPIMAGE_DEST" 2>/dev/null || true
    exit 1
  fi

  cp "'"$REPO_ROOT"'/'"$APPIMAGE_SRC"'" "$APPIMAGE_DEST"
  chmod +x "$APPIMAGE_DEST"

  if ! systemctl --user cat slack-manager.service >/dev/null 2>&1; then
    bash "'"$REPO_ROOT"'/packages/slack-manager/deploy/install.sh"
  else
    systemctl --user daemon-reload
    systemctl --user enable --now slack-manager.service
    systemctl --user start slack-manager.service
  fi
  systemctl --user is-active --quiet slack-manager.service

  if ! owner_is_up; then
    setsid nohup "'"$REPO_ROOT"'/$APPIMAGE_DEST" --no-sandbox --disable-dev-shm-usage --disable-gpu --disable-gpu-compositing --disable-gpu-sandbox --disable-software-rasterizer --headless owner-serve </dev/null >/tmp/deploy-do1-owner-launch.log 2>&1 &
  fi

  for _ in $(seq 1 45); do
    if owner_is_up; then
      break
    fi
    sleep 1
  done
  owner_is_up
' </dev/null >"$LOG_FILE" 2>&1 &
RESTART_PID=$!

# Poll for the detached restart sequence to finish. If this SSH session
# gets torn down here (e.g. because the step above just killed the very
# process running this deploy), the detached job above is unaffected and
# keeps running to completion on this host regardless.
for _ in $(seq 1 60); do
  kill -0 "$RESTART_PID" 2>/dev/null || break
  sleep 1
done

if kill -0 "$RESTART_PID" 2>/dev/null; then
  echo "restart sequence did not finish within 60s" >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi

wait "$RESTART_PID" && RESTART_STATUS=0 || RESTART_STATUS=$?
cat "$LOG_FILE"
rm -f "$LOG_FILE"
[ "$RESTART_STATUS" -eq 0 ] || {
  echo "Invoker owner did not relaunch (see log above)" >&2
  exit 1
}

echo "DO1 deploy complete"
echo "sha=$TARGET_SHA"
echo "surfaces_dist_mtime=$SURFACES_MTIME_AFTER"
systemctl --user show slack-manager.service -p MainPID,ActiveEnterTimestamp --no-pager
REMOTE
