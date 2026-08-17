#!/usr/bin/env bash
set -euo pipefail

# Run one command (or a script piped via stdin) against every configured SSH
# remote target in parallel, tagging each host's output. Read-only by
# design: this script never mutates remote state itself, only whatever the
# given command does.
#
# Reads the same config source as Invoker:
#   INVOKER_REPO_CONFIG_PATH=/path/to/config.json
# or, when unset:
#   ~/.invoker/config.json
#
# Usage:
#   scripts/fleet-ssh.sh 'git -C ~/Invoker log -1 --oneline'
#   scripts/fleet-ssh.sh --hosts remote_digital_ocean_3,remote_digital_ocean_5 'uptime'
#   cat script.sh | scripts/fleet-ssh.sh --stdin
#   scripts/fleet-ssh.sh --list

CONFIG_PATH="${INVOKER_REPO_CONFIG_PATH:-$HOME/.invoker/config.json}"
HOSTS_FILTER=""
USE_STDIN=false
LIST_ONLY=false
TIMEOUT_SECONDS="${FLEET_SSH_TIMEOUT_SECONDS:-30}"

usage() {
  cat <<'EOF'
Usage:
  fleet-ssh.sh [--hosts id1,id2,...] '<command>'
  fleet-ssh.sh [--hosts id1,id2,...] --stdin   (reads script body from stdin)
  fleet-ssh.sh --list                          (print configured target ids and hosts, no SSH)

Options:
  --hosts id1,id2,...   Only run against these target ids (comma-separated).
                         Default: every remoteTargets entry in config.json.
  --stdin               Read the command/script body from stdin instead of argv.
  --list                Print configured targets and exit; makes no SSH connections.

Env:
  INVOKER_REPO_CONFIG_PATH   Path to config.json (default: ~/.invoker/config.json)
  FLEET_SSH_TIMEOUT_SECONDS  Per-host SSH ConnectTimeout (default: 30)
EOF
}

COMMAND=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hosts)
      HOSTS_FILTER="$2"
      shift 2
      ;;
    --stdin)
      USE_STDIN=true
      shift
      ;;
    --list)
      LIST_ONLY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      COMMAND="$1"
      shift
      ;;
  esac
done

if [[ "$LIST_ONLY" = false && "$USE_STDIN" = false && -z "$COMMAND" ]]; then
  usage >&2
  exit 2
fi

if [[ "$USE_STDIN" = true ]]; then
  COMMAND="$(cat)"
fi

TARGETS_FILE="$(mktemp)"
trap 'rm -f "$TARGETS_FILE"' EXIT

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
  if (!host || !user || !keyPath) {
    console.error(`Skipping incomplete remote target: ${id}`);
    continue;
  }
  process.stdout.write([id, host, user, port, keyPath].join('\t') + '\n');
}
NODE

if [[ ! -s "$TARGETS_FILE" ]]; then
  echo "No SSH remote targets found in $CONFIG_PATH" >&2
  exit 1
fi

if [[ "$LIST_ONLY" = true ]]; then
  echo "id	host	user	port"
  while IFS=$'\t' read -r id host user port key_path; do
    echo "$id	$host	$user	$port"
  done < "$TARGETS_FILE"
  exit 0
fi

IFS=',' read -ra HOSTS_ARRAY <<< "$HOSTS_FILTER"

should_run() {
  local id="$1"
  [[ -z "$HOSTS_FILTER" ]] && return 0
  for h in "${HOSTS_ARRAY[@]}"; do
    [[ "$h" == "$id" ]] && return 0
  done
  return 1
}

PIDS=()
OUT_FILES=()
IDS=()

while IFS=$'\t' read -r id host user port key_path; do
  should_run "$id" || continue
  out_file="$(mktemp)"
  OUT_FILES+=("$out_file")
  IDS+=("$id")
  (
    set +e  # a failing remote command must not kill this subshell before its exit code is captured
    ssh -i "$key_path" -p "$port" -o ConnectTimeout="$TIMEOUT_SECONDS" -o BatchMode=yes \
      "${user}@${host}" "$COMMAND" > "$out_file" 2>&1
    echo "__FLEET_SSH_EXIT__=$?" >> "$out_file"
  ) &
  PIDS+=("$!")
done < "$TARGETS_FILE"

if [[ ${#PIDS[@]} -eq 0 ]]; then
  echo "No matching targets for --hosts filter: $HOSTS_FILTER" >&2
  exit 1
fi

FAILED=0
for i in "${!PIDS[@]}"; do
  wait "${PIDS[$i]}" || true
  id="${IDS[$i]}"
  out_file="${OUT_FILES[$i]}"
  exit_code="$(grep -o '__FLEET_SSH_EXIT__=[0-9]*' "$out_file" | tail -1 | cut -d= -f2)"
  echo "=== $id (exit=${exit_code:-unknown}) ==="
  grep -v '__FLEET_SSH_EXIT__=' "$out_file" || true
  echo
  if [[ "${exit_code:-1}" != "0" ]]; then
    FAILED=1
  fi
  rm -f "$out_file"
done

exit "$FAILED"
