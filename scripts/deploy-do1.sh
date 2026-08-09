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

systemctl --user unmask slack-manager.service 2>/dev/null || true

# From here on we stop slack-manager, kill the owner, and restart
# slack-manager -- and if this deploy is itself running as an Invoker task
# on this same host (a self-targeted redeploy triggered from Slack), the
# owner kill below tears down the very process tree running this script:
# the owner's graceful-shutdown path (packages/app/src/main.ts
# handleHeadlessTerminationSignal -> runHeadlessShutdownCleanup) calls
# executorRegistry.destroyAll(), which SIGTERMs every still-running task's
# process group (packages/execution-engine/src/worktree-executor.ts
# destroyAll -> killProcessGroup), including this one. Without protection,
# that abandons the sequence mid-flight -- possibly right after
# `stop slack-manager.service` and before `restart` -- leaving Slack dark
# until someone SSHes in by hand. Run the tail in its own process group via
# setsid, detached from this shell, so killing *this* task's group cannot
# take the restart sequence down with it.
LOG_FILE="$(mktemp)"
setsid bash -c '
  set -euo pipefail
  cd "'"$REPO_ROOT"'"

  systemctl --user stop slack-manager.service 2>/dev/null || true
  python3 - "'"$REPO_ROOT"'" <<PY
import os
import signal
import sys

repo_root = os.path.realpath(sys.argv[1])
process_groups = set()
for name in os.listdir("/proc"):
    if not name.isdigit():
        continue
    pid = int(name)
    try:
        if os.path.realpath(f"/proc/{pid}/cwd") != repo_root:
            continue
        with open(f"/proc/{pid}/cmdline", "rb") as proc:
            command = proc.read().replace(b"\0", b" ").decode(errors="replace")
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        continue
    if "packages/app/dist/main.js" in command:
        process_groups.add(os.getpgid(pid))

for process_group in process_groups:
    try:
        os.killpg(process_group, signal.SIGTERM)
    except ProcessLookupError:
        pass
PY

  # Install/refresh the user unit when missing (e.g. after local cutover removed it).
  if ! systemctl --user cat slack-manager.service >/dev/null 2>&1; then
    bash "'"$REPO_ROOT"'/packages/slack-manager/deploy/install.sh"
  else
    systemctl --user daemon-reload
    systemctl --user enable --now slack-manager.service
    systemctl --user restart slack-manager.service
  fi
  systemctl --user is-active --quiet slack-manager.service

  for _ in $(seq 1 45); do
    if pgrep -f "packages/app/dist/main.js --headless owner-serve" >/dev/null; then
      break
    fi
    sleep 1
  done
  pgrep -f "packages/app/dist/main.js --headless owner-serve" >/dev/null
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
