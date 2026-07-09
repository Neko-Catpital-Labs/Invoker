#!/usr/bin/env bash
set -euo pipefail

# Clean Invoker-managed state on every configured SSH remote, sync local
# Claude/Codex credentials to those remotes, then rebase-recreate all workflows.
#
# This script reads the same config source as Invoker:
#   INVOKER_REPO_CONFIG_PATH=/path/to/config.json
# or, when unset:
#   ~/.invoker/config.json
#
# Usage:
#   scripts/cleanup-ssh-sync-creds-rebase-recreate-all.sh --dry-run
#   scripts/cleanup-ssh-sync-creds-rebase-recreate-all.sh --yes
#
# Optional:
#   INVOKER_SSH_CREDENTIAL_PATHS="$HOME/.claude.json:$HOME/.claude/settings.json:$HOME/.codex/auth.json:$HOME/.codex/config.toml"

DRY_RUN=false
YES=false
SKIP_CLEANUP=false
SKIP_CREDS=false
SKIP_REBASE_RECREATE=false
REBASE_RECREATE_TIMEOUT_SECONDS="${REBASE_RECREATE_TIMEOUT_SECONDS:-900}"
IDLE_TIMEOUT_SECONDS="${IDLE_TIMEOUT_SECONDS:-900}"
IDLE_POLL_SECONDS="${IDLE_POLL_SECONDS:-5}"
IDLE_STALE_HEARTBEAT_SECONDS="${IDLE_STALE_HEARTBEAT_SECONDS:-600}"

usage() {
  cat <<'EOF'
Usage: scripts/cleanup-ssh-sync-creds-rebase-recreate-all.sh [options]

Options:
  --yes                    Run destructive remote cleanup and workflow dispatch.
  --dry-run                Print what would run without changing remotes/workflows.
  --skip-cleanup           Do not delete remote Invoker-managed runtime/repos/worktrees.
  --skip-creds             Do not sync Claude/Codex credential files.
  --skip-rebase-recreate   Do not dispatch workflow rebase-recreate commands.
  --timeout <seconds>      Timeout passed to bench-rebase-recreate-all.sh.
  --idle-timeout <seconds> Maximum time to wait for Invoker to become idle before cleanup.
                           Use 0 to wait indefinitely.
  --stale-heartbeat <sec>  Fail idle wait when a running task heartbeat is older than this.
                           Defaults to 600.
  -h, --help               Show this help.

Environment:
  INVOKER_REPO_CONFIG_PATH       Repo-specific Invoker config path.
  INVOKER_SSH_CREDENTIAL_PATHS   Colon-separated local paths to sync.
                                Defaults to Claude/Codex auth + config files.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes)
      YES=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --skip-cleanup)
      SKIP_CLEANUP=true
      shift
      ;;
    --skip-creds)
      SKIP_CREDS=true
      shift
      ;;
    --skip-rebase-recreate)
      SKIP_REBASE_RECREATE=true
      shift
      ;;
    --timeout)
      REBASE_RECREATE_TIMEOUT_SECONDS="${2:-}"
      shift 2
      ;;
    --idle-timeout)
      IDLE_TIMEOUT_SECONDS="${2:-}"
      shift 2
      ;;
    --stale-heartbeat)
      IDLE_STALE_HEARTBEAT_SECONDS="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$DRY_RUN" = false && "$YES" = false ]]; then
  echo "Refusing to run without --yes. Use --dry-run to preview." >&2
  exit 1
fi

if ! [[ "$REBASE_RECREATE_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --timeout value: $REBASE_RECREATE_TIMEOUT_SECONDS" >&2
  exit 1
fi
if ! [[ "$IDLE_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "Invalid --idle-timeout value: $IDLE_TIMEOUT_SECONDS" >&2
  exit 1
fi
if ! [[ "$IDLE_STALE_HEARTBEAT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --stale-heartbeat value: $IDLE_STALE_HEARTBEAT_SECONDS" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGETS_FILE="$(mktemp -t invoker-ssh-targets.XXXXXX)"
LOCK_DIR="${TMPDIR:-/tmp}/invoker-cleanup-ssh-sync-creds-rebase-recreate-all.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"

cleanup() {
  rm -f "$TARGETS_FILE" >/dev/null 2>&1 || true
  if [[ "${LOCK_ACQUIRED:-false}" = true ]]; then
    rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_ACQUIRED=true
  printf '%s\n' "$$" > "$LOCK_PID_FILE"
else
  existing_pid=""
  if [[ -f "$LOCK_PID_FILE" ]]; then
    existing_pid="$(cat "$LOCK_PID_FILE" 2>/dev/null || true)"
  fi
  lock_is_stale=false
  if [[ -z "$existing_pid" || ! "$existing_pid" =~ ^[0-9]+$ ]]; then
    lock_is_stale=true
  elif ! kill -0 "$existing_pid" 2>/dev/null; then
    lock_is_stale=true
  fi
  if [[ "$lock_is_stale" = true ]]; then
    rm -rf "$LOCK_DIR"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      LOCK_ACQUIRED=true
      printf '%s\n' "$$" > "$LOCK_PID_FILE"
    else
      echo "Another cleanup/sync/rebase-recreate run is already active: $LOCK_DIR" >&2
      exit 75
    fi
  else
    echo "Another cleanup/sync/rebase-recreate run is already active: $LOCK_DIR" >&2
    exit 75
  fi
fi

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
}

require_command node
require_command ssh
require_command sqlite3
if [[ "$SKIP_CREDS" = false ]]; then
  require_command rsync
fi

CONFIG_PATH="${INVOKER_REPO_CONFIG_PATH:-$HOME/.invoker/config.json}"
DB_PATH="${INVOKER_DB_PATH:-${INVOKER_DB_DIR:-$HOME/.invoker}/invoker.db}"

wait_for_invoker_idle() {
  if [[ ! -f "$DB_PATH" ]]; then
    echo "Invoker DB not found yet; skipping idle wait: $DB_PATH"
    return 0
  fi

  local started_at now active_tasks active_mutations stale_tasks
  started_at="$(date +%s)"
  while true; do
    active_tasks="$(sqlite3 "$DB_PATH" "select count(*) from tasks where status in ('running','fixing_with_ai');")"
    active_mutations="$(sqlite3 "$DB_PATH" "select count(*) from workflow_mutation_intents where status in ('queued','running');")"
    stale_tasks="$(sqlite3 "$DB_PATH" "
      select count(*)
      from tasks
      where status in ('running','fixing_with_ai')
        and (
          last_heartbeat_at is null
          or (julianday('now') - julianday(last_heartbeat_at)) * 86400.0 >= $IDLE_STALE_HEARTBEAT_SECONDS
        );
    ")"
    if [[ "$stale_tasks" != "0" ]]; then
      echo "Refusing to wait indefinitely: found $stale_tasks stale running task(s) with heartbeat age >= ${IDLE_STALE_HEARTBEAT_SECONDS}s." >&2
      sqlite3 -header -separator $'\t' "$DB_PATH" "
        select id,
               status,
               runner_kind,
               coalesce(pool_member_id, '') as pool_member_id,
               coalesce(started_at, '') as started_at,
               coalesce(last_heartbeat_at, '') as last_heartbeat_at,
               cast((julianday('now') - julianday(last_heartbeat_at)) * 86400 as integer) as heartbeat_age_seconds
          from tasks
         where status in ('running','fixing_with_ai')
           and (
             last_heartbeat_at is null
             or (julianday('now') - julianday(last_heartbeat_at)) * 86400.0 >= $IDLE_STALE_HEARTBEAT_SECONDS
           )
         order by heartbeat_age_seconds desc;
      " >&2
      return 1
    fi
    if [[ "$active_tasks" = "0" && "$active_mutations" = "0" ]]; then
      echo "Invoker is idle; remote cleanup can proceed."
      return 0
    fi

    now="$(date +%s)"
    if (( IDLE_TIMEOUT_SECONDS > 0 && now - started_at >= IDLE_TIMEOUT_SECONDS )); then
      echo "Timed out waiting for Invoker idle state before remote cleanup (tasks=$active_tasks mutations=$active_mutations)." >&2
      echo "Refusing to delete remote managed workspaces while Invoker is active." >&2
      return 1
    fi
    echo "Waiting for Invoker idle before remote cleanup: active_tasks=$active_tasks active_mutations=$active_mutations"
    sleep "$IDLE_POLL_SECONDS"
  done
}

CONFIG_PATH="$CONFIG_PATH" node > "$TARGETS_FILE" <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

const configPath = expandHome(process.env.CONFIG_PATH || path.join(os.homedir(), '.invoker', 'config.json'));
if (!fs.existsSync(configPath)) {
  console.error(`Invoker config not found: ${configPath}`);
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const targets = config.remoteTargets || {};

for (const [id, target] of Object.entries(targets)) {
  if (!target || typeof target !== 'object') continue;
  const host = String(target.host || '');
  const user = String(target.user || '');
  const keyPath = expandHome(String(target.sshKeyPath || ''));
  const port = String(target.port || 22);
  const remoteInvokerHome = String(target.remoteInvokerHome || '~/.invoker');
  if (!host || !user || !keyPath) {
    console.error(`Skipping incomplete remote target: ${id}`);
    continue;
  }
  process.stdout.write([id, host, user, port, keyPath, remoteInvokerHome].join('\t') + '\n');
}
NODE

if [[ ! -s "$TARGETS_FILE" ]]; then
  echo "No SSH remote targets found in $CONFIG_PATH" >&2
  exit 0
fi

ssh_base_args() {
  local port="$1"
  local key_path="$2"
  SSH_ARGS=(
    -p "$port"
    -i "$key_path"
    -o BatchMode=yes
    -o StrictHostKeyChecking=accept-new
  )
}

run_ssh_script() {
  local target_label="$1"
  local user_host="$2"
  local port="$3"
  local key_path="$4"
  local script_body="$5"

  echo "[$target_label] ssh $user_host"
  if [[ "$DRY_RUN" = true ]]; then
    printf '%s\n' "$script_body" | sed 's/^/  | /'
    return 0
  fi

  local -a SSH_ARGS
  ssh_base_args "$port" "$key_path"
  ssh "${SSH_ARGS[@]}" "$user_host" 'bash -s' <<< "$script_body"
}

remote_cleanup_script() {
  local remote_invoker_home="$1"
  REMOTE_INVOKER_HOME="$remote_invoker_home" node <<'NODE'
const value = process.env.REMOTE_INVOKER_HOME || '~/.invoker';
const b64 = Buffer.from(value, 'utf8').toString('base64');
process.stdout.write(`set -euo pipefail
INVOKER_HOME="$(printf '%s' '${b64}' | base64 -d)"
if [[ "$INVOKER_HOME" == '~' ]]; then
  INVOKER_HOME="$HOME"
elif [[ "\${INVOKER_HOME:0:2}" == '~/' ]]; then
  INVOKER_HOME="$HOME/\${INVOKER_HOME:2}"
fi
case "$INVOKER_HOME" in
  ""|"/"|"$HOME")
    echo "Refusing unsafe remoteInvokerHome: $INVOKER_HOME" >&2
    exit 64
    ;;
esac
mkdir -p "$INVOKER_HOME"
chmod 700 "$INVOKER_HOME"
tmp_pids="$(mktemp -t invoker-remote-cleanup-pids.XXXXXX)"
ps -eo pid=,args= \
  | awk -v home="$INVOKER_HOME" -v self="$$" -v parent="$PPID" '
      $1 != self && $1 != parent && index($0, home) > 0 { print $1 }
    ' > "$tmp_pids" || true
if [[ -s "$tmp_pids" ]]; then
  xargs -r kill -TERM < "$tmp_pids" 2>/dev/null || true
  sleep 2
  xargs -r kill -KILL < "$tmp_pids" 2>/dev/null || true
fi
rm -f "$tmp_pids"
remove_invoker_path() {
  local path="$1"
  local attempt
  for attempt in 1 2 3; do
    rm -rf "$path" 2>/dev/null || true
    [[ ! -e "$path" ]] && return 0
    find "$path" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
    rm -rf "$path" 2>/dev/null || true
    [[ ! -e "$path" ]] && return 0
    sleep "$attempt"
  done
  rm -rf "$path"
}
remove_invoker_path "$INVOKER_HOME/runtime"
remove_invoker_path "$INVOKER_HOME/repos"
remove_invoker_path "$INVOKER_HOME/worktrees"
if [[ -e "$INVOKER_HOME/runtime" || -e "$INVOKER_HOME/repos" || -e "$INVOKER_HOME/worktrees" ]]; then
  find "$INVOKER_HOME/runtime" "$INVOKER_HOME/repos" "$INVOKER_HOME/worktrees" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$INVOKER_HOME/runtime" "$INVOKER_HOME/repos" "$INVOKER_HOME/worktrees" 2>/dev/null || true
fi
mkdir -p "$INVOKER_HOME/runtime" "$INVOKER_HOME/repos" "$INVOKER_HOME/worktrees"
chmod 700 "$INVOKER_HOME/runtime" "$INVOKER_HOME/repos" "$INVOKER_HOME/worktrees"
`);
NODE
}

sync_credentials_to_target() {
  local target_label="$1"
  local user_host="$2"
  local port="$3"
  local key_path="$4"

  local credential_paths="${INVOKER_SSH_CREDENTIAL_PATHS:-$HOME/.claude.json:$HOME/.claude/settings.json:$HOME/.claude/mcp-needs-auth-cache.json:$HOME/.codex/auth.json:$HOME/.codex/config.toml}"
  local path_entry=""
  local remote_rel=""
  local remote_parent=""
  local remote_dest=""

  IFS=':' read -r -a credential_array <<< "$credential_paths"
  for path_entry in "${credential_array[@]}"; do
    [[ -z "$path_entry" ]] && continue
    path_entry="${path_entry/#\~/$HOME}"
    if [[ ! -e "$path_entry" ]]; then
      echo "[$target_label] skip missing credential path: $path_entry"
      continue
    fi

    if [[ "$path_entry" == "$HOME/"* ]]; then
      remote_rel="${path_entry#"$HOME"/}"
    else
      remote_rel="$(basename "$path_entry")"
    fi
    remote_parent="$(dirname "$remote_rel")"
    remote_dest="~/$remote_rel"

    echo "[$target_label] sync $path_entry -> $user_host:$remote_dest"
    if [[ "$DRY_RUN" = true ]]; then
      continue
    fi

    local -a SSH_ARGS
    ssh_base_args "$port" "$key_path"
    ssh "${SSH_ARGS[@]}" "$user_host" "mkdir -p ~/'$remote_parent' && chmod 700 ~" </dev/null

    if [[ -d "$path_entry" ]]; then
      rsync -az --delete \
        --exclude '.tmp/' \
        --exclude 'tmp/' \
        --exclude 'cache/' \
        --exclude 'generated_images/' \
        --exclude 'logs*.sqlite*' \
        --exclude 'state*.sqlite*' \
        -e "ssh -p $port -i $(printf '%q' "$key_path") -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
        "$path_entry/" "$user_host:$remote_dest/"
    else
      rsync -az \
        -e "ssh -p $port -i $(printf '%q' "$key_path") -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
        "$path_entry" "$user_host:$remote_dest"
    fi
  done
}

echo "Config: $CONFIG_PATH"
echo "Targets:"
awk -F '\t' '{ printf "  - %s (%s@%s:%s, remoteInvokerHome=%s)\n", $1, $3, $2, $4, $6 }' "$TARGETS_FILE"

if [[ "$SKIP_CLEANUP" = false && "$DRY_RUN" = false ]]; then
  wait_for_invoker_idle
fi

while IFS=$'\t' read -r target_id host user port key_path remote_invoker_home; do
  [[ -z "$target_id" ]] && continue
  user_host="$user@$host"

  if [[ ! -f "$key_path" ]]; then
    echo "[$target_id] SSH key not found: $key_path" >&2
    exit 1
  fi

  if [[ "$SKIP_CLEANUP" = false ]]; then
    run_ssh_script "$target_id" "$user_host" "$port" "$key_path" "$(remote_cleanup_script "$remote_invoker_home")"
  fi

  if [[ "$SKIP_CREDS" = false ]]; then
    sync_credentials_to_target "$target_id" "$user_host" "$port" "$key_path"
  fi
done < "$TARGETS_FILE"

if [[ "$SKIP_REBASE_RECREATE" = false ]]; then
  echo "Dispatching rebase-recreate for all workflows..."
  if [[ "$DRY_RUN" = true ]]; then
    bash "$REPO_ROOT/scripts/bench-rebase-recreate-all.sh" --dry-run --timeout "$REBASE_RECREATE_TIMEOUT_SECONDS"
  else
    bash "$REPO_ROOT/scripts/bench-rebase-recreate-all.sh" --timeout "$REBASE_RECREATE_TIMEOUT_SECONDS"
  fi
fi
