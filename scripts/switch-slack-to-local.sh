#!/usr/bin/env bash
# Kill remote slack-manager consumer(s), then run Slack Socket Mode locally
# from this checkout so @Invoker uses local surfaces/dist (not DO1's stale build).
#
# Usage:
#   bash scripts/switch-slack-to-local.sh
#   bash scripts/switch-slack-to-local.sh --dry-run
#   bash scripts/switch-slack-to-local.sh --force-start   # skip remote kill (you already stopped it)
#   bash scripts/switch-slack-to-local.sh --kill-only
#   bash scripts/switch-slack-to-local.sh --no-build
#   bash scripts/switch-slack-to-local.sh --daemon        # background + write pid/log
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${INVOKER_DO1_CONFIG_PATH:-${INVOKER_CONFIG_PATH:-$HOME/.invoker/config.json}}"
OWNER_ENV="${INVOKER_SLACK_OWNER_ENV:-$HOME/.invoker/.slack-owner.env}"
DOTENV="$HOME/.invoker/.env"
# Default: canonical DO1 only. Override to scan more hosts:
#   INVOKER_SLACK_REMOTE_TARGETS="remote_digital_ocean_1 remote_digital_ocean_4" ...
REQUIRED_TARGET_ID="${INVOKER_DO1_TARGET_ID:-remote_digital_ocean_1}"
# Extra hosts to also stop (optional). Required target is always included.
TARGET_IDS_DEFAULT="$REQUIRED_TARGET_ID"
SSH_CONNECT_TIMEOUT="${INVOKER_SLACK_SSH_TIMEOUT:-10}"
LOG_DIR="$HOME/.invoker/slack-manager"
PID_FILE="$LOG_DIR/local-slack-manager.pid"
LOG_FILE="$LOG_DIR/local-slack-manager.log"

DRY_RUN=0
FORCE_START=0
KILL_ONLY=0
NO_BUILD=0
DAEMON=0
TARGET_IDS="${INVOKER_SLACK_REMOTE_TARGETS:-$TARGET_IDS_DEFAULT}"
# Always ensure the required target is in the list.
case " $TARGET_IDS " in
  *" $REQUIRED_TARGET_ID "*) ;;
  *) TARGET_IDS="$REQUIRED_TARGET_ID $TARGET_IDS" ;;
esac

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force-start) FORCE_START=1 ;;
    --kill-only) KILL_ONLY=1 ;;
    --no-build) NO_BUILD=1 ;;
    --daemon) DAEMON=1 ;;
    --targets)
      shift
      TARGET_IDS="${1:-}"
      [[ -n "$TARGET_IDS" ]] || { echo "--targets requires a value" >&2; exit 2; }
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log() { printf '[switch-slack-to-local] %s\n' "$*"; }
die() { printf '[switch-slack-to-local] ERROR: %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require_cmd node
require_cmd ssh
require_cmd pnpm
require_cmd grep

[[ -f "$CONFIG_PATH" ]] || die "missing config: $CONFIG_PATH"
[[ -f "$DOTENV" ]] || die "missing $DOTENV (need SLACK_* credentials)"

ensure_owner_env() {
  if [[ -f "$OWNER_ENV" ]]; then
    log "owner env: $OWNER_ENV"
  else
    log "creating $OWNER_ENV from $DOTENV"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      return 0
    fi
    cp "$DOTENV" "$OWNER_ENV"
    chmod 600 "$OWNER_ENV"
  fi
  local missing=()
  local key
  for key in SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_SIGNING_SECRET SLACK_CHANNEL_ID; do
    if ! grep -qE "^${key}=" "$OWNER_ENV" 2>/dev/null; then
      missing+=("$key")
    fi
  done
  if [[ "${#missing[@]}" -gt 0 ]]; then
    die "owner env missing: ${missing[*]} (in $OWNER_ENV)"
  fi
  log "lobby channel: $(grep -E '^SLACK_CHANNEL_ID=' "$OWNER_ENV" | head -1 | cut -d= -f2-)"
}

resolve_target() {
  local target_id="$1"
  node - "$CONFIG_PATH" "$target_id" <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const [configPath, targetId] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const target = config.remoteTargets?.[targetId];
if (!target?.host || !target?.user || !target?.sshKeyPath) process.exit(2);
const expandHome = (value) => value.startsWith('~/') ? `${os.homedir()}/${value.slice(2)}` : value;
process.stdout.write([target.host, target.user, expandHome(target.sshKeyPath)].join('\t'));
NODE
}

kill_remote_on_host() {
  local target_id="$1" host="$2" user="$3" key_path="$4"
  log "killing slack-manager on $target_id ($user@$host)…"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "dry-run: skip ssh $user@$host"
    return 0
  fi
  [[ -r "$key_path" ]] || { log "skip $target_id: ssh key not readable ($key_path)"; return 1; }

  local rc=0
  # shellcheck disable=SC2029
  ssh -i "$key_path" \
    -o StrictHostKeyChecking=accept-new \
    -o BatchMode=yes \
    -o ConnectTimeout="$SSH_CONNECT_TIMEOUT" \
    "$user@$host" \
    bash -s <<'REMOTE' || rc=$?
set -euo pipefail
echo "HOST=$(hostname)"
# Disable+mask so Restart= cannot revive a stale Socket Mode consumer.
systemctl --user disable --now slack-manager.service 2>/dev/null || true
systemctl --user mask slack-manager.service 2>/dev/null || true
systemctl --user stop slack-manager.service 2>/dev/null || true
echo "SYSTEMD=disabled-masked-or-absent"
# Also kill stray node processes for this daemon / published binary.
pkill -f 'packages/slack-manager/dist/index.js' 2>/dev/null || true
pkill -f '/invoker-slack' 2>/dev/null || true
pkill -f 'node .*slack-manager' 2>/dev/null || true
sleep 1
active="$(systemctl --user is-active slack-manager.service 2>/dev/null || true)"
active="${active:-n/a}"
echo "ACTIVE=$active"
procs="$(pgrep -af 'slack-manager|invoker-slack' || true)"
if [[ -n "${procs}" ]]; then
  echo "PROCS_STILL_RUNNING"
  echo "$procs"
  exit 3
fi
echo "PROCS=none"
if [[ "$active" == "active" ]]; then
  exit 3
fi
exit 0
REMOTE
  if [[ "$rc" -eq 0 ]]; then
    log "killed/confirmed-down on $target_id"
    return 0
  fi
  log "failed to kill $target_id (ssh/rc=$rc)"
  return "$rc"
}

kill_remotes() {
  local id host user key
  local line
  local pids=()
  local tmpdir
  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/switch-slack-kill.XXXXXX")"
  # Parallel SSH kills so multiple targets don't serialize ConnectTimeout.
  for id in $TARGET_IDS; do
    if ! line="$(resolve_target "$id" 2>/dev/null)"; then
      log "skip $id: not in $CONFIG_PATH"
      continue
    fi
    IFS=$'\t' read -r host user key <<<"$line"
    (
      if kill_remote_on_host "$id" "$host" "$user" "$key"; then
        echo ok >"$tmpdir/$id.ok"
      else
        echo fail >"$tmpdir/$id.fail"
      fi
    ) &
    pids+=("$!")
  done
  local pid
  for pid in "${pids[@]:-}"; do
    wait "$pid" || true
  done

  local required_ok=0
  if [[ -f "$tmpdir/$REQUIRED_TARGET_ID.ok" ]]; then
    required_ok=1
  fi
  rm -rf "$tmpdir"

  if [[ "$FORCE_START" -eq 1 ]]; then
    log "--force-start: not requiring $REQUIRED_TARGET_ID kill success"
    return 0
  fi
  if [[ "$DRY_RUN" -eq 1 ]]; then
    return 0
  fi
  if [[ "$required_ok" -eq 0 ]]; then
    cat >&2 <<EOF
ERROR: could not SSH to $REQUIRED_TARGET_ID to stop slack-manager.

Port 22 to that droplet is unreachable from this network, but the remote
Socket Mode consumer is still holding the Slack app connection.

Fix one of:
  1) Restore SSH to $REQUIRED_TARGET_ID, then re-run this script
  2) In DigitalOcean web console on that droplet:
       systemctl --user stop slack-manager.service
       pkill -f slack-manager || true
     then re-run with:  bash scripts/switch-slack-to-local.sh --force-start
  3) Rotate the Slack App-Level Token (xapp-...) in api.slack.com → Socket Mode,
     update ~/.invoker/.env and ~/.invoker/.slack-owner.env, then:
       bash scripts/switch-slack-to-local.sh --force-start
EOF
    exit 1
  fi
}

stop_local_slack() {
  if [[ -f "$PID_FILE" ]]; then
    local old_pid
    old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
      log "stopping previous local slack-manager pid=$old_pid"
      if [[ "$DRY_RUN" -eq 0 ]]; then
        kill "$old_pid" 2>/dev/null || true
        sleep 1
        kill -9 "$old_pid" 2>/dev/null || true
      fi
    fi
    rm -f "$PID_FILE"
  fi
  # Best-effort: any local slack-manager from this repo.
  if [[ "$DRY_RUN" -eq 0 ]]; then
    pkill -f "$REPO_ROOT/packages/slack-manager/dist/index.js" 2>/dev/null || true
  fi
}

build_local() {
  if [[ "$NO_BUILD" -eq 1 ]]; then
    log "skip build (--no-build)"
    return 0
  fi
  log "building surfaces + slack-manager…"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    return 0
  fi
  (
    cd "$REPO_ROOT"
    pnpm --filter @invoker/surfaces build
    pnpm --filter @invoker/slack-manager build
  )
}

verify_local_dist() {
  local surfaces_dist="$REPO_ROOT/packages/surfaces/dist/index.js"
  local manager_dist="$REPO_ROOT/packages/slack-manager/dist/index.js"
  [[ -s "$surfaces_dist" ]] || die "missing $surfaces_dist (build failed?)"
  [[ -s "$manager_dist" ]] || die "missing $manager_dist (build failed?)"
  # Old exclusive plan refusal — planning is allowed outside lobby now.
  # Non-lobby restart/submit/workflow control messaging is still intentional.
  local stale="I only plan in the lobby channel (or DMs)"
  if grep -qF "$stale" "$surfaces_dist"; then
    die "stale refusal still in surfaces dist: $stale"
  fi
  grep -qF "[MENTION_ROUTE]" "$surfaces_dist" || die "surfaces dist missing [MENTION_ROUTE] marker"
  log "local dist ok (no lobby plan refusal; mention routing present)"
}

start_local() {
  mkdir -p "$LOG_DIR"
  export INVOKER_SLACK_OWNER_ENV="$OWNER_ENV"
  export INVOKER_REPO_ROOT="$REPO_ROOT"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "dry-run: would start: pnpm --filter @invoker/slack-manager start"
    return 0
  fi
  if [[ "$DAEMON" -eq 1 ]]; then
    log "starting local slack-manager in background (log=$LOG_FILE)"
    (
      cd "$REPO_ROOT"
      nohup pnpm --filter @invoker/slack-manager start >>"$LOG_FILE" 2>&1 &
      echo $! >"$PID_FILE"
    )
    sleep 1
    local pid
    pid="$(cat "$PID_FILE")"
    kill -0 "$pid" 2>/dev/null || die "local slack-manager failed to stay up; see $LOG_FILE"
    log "local slack-manager pid=$pid"
    log "prove with: @Invoker hi in #$(grep -E '^SLACK_CHANNEL_ID=' "$OWNER_ENV" | head -1 | cut -d= -f2-) / your lobby channel"
    return 0
  fi
  log "starting local slack-manager in foreground (Ctrl-C to stop)"
  cd "$REPO_ROOT"
  exec pnpm --filter @invoker/slack-manager start
}

main() {
  log "repo=$REPO_ROOT"
  ensure_owner_env
  kill_remotes
  if [[ "$KILL_ONLY" -eq 1 ]]; then
    log "kill-only complete"
    exit 0
  fi
  stop_local_slack
  # Stop packaged Invoker.app / Electron owners that still embed Socket Mode.
  if [[ "$DRY_RUN" -eq 0 && -x "$REPO_ROOT/scripts/kill-all-electron.sh" ]]; then
    log "killing local Electron/Invoker.app Socket Mode competitors…"
    bash "$REPO_ROOT/scripts/kill-all-electron.sh" || true
  fi
  build_local
  verify_local_dist
  start_local
}

main
