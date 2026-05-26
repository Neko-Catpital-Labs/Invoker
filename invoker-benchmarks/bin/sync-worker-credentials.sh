#!/usr/bin/env bash
set -euo pipefail

WRITE_WORKERS=""
NO_SSH=0

usage() {
  cat <<'EOF'
Usage: sync-worker-credentials.sh [--write-workers PATH] [--no-ssh]

Generates workers.json from ~/.invoker/config.json. Unless --no-ssh is passed,
also syncs Codex, Claude, SSH, and Invoker config directories to enabled workers.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --write-workers) WRITE_WORKERS="${2:-}"; shift 2 ;;
    --no-ssh) NO_SSH=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: $1" ;;
  esac
done

CONFIG_PATH="${INVOKER_CONFIG_PATH:-$HOME/.invoker/config.json}"
[[ -f "$CONFIG_PATH" ]] || die "Missing Invoker config: $CONFIG_PATH"

if [[ -n "$WRITE_WORKERS" ]]; then
  mkdir -p "$(dirname "$WRITE_WORKERS")"
  python3 - "$CONFIG_PATH" "$WRITE_WORKERS" <<'PY'
import json
import sys
from pathlib import Path

config_path, out_path = map(Path, sys.argv[1:])
config = json.loads(config_path.read_text())
raw_targets = config.get("remoteTargets") or config.get("sshTargets") or config.get("remotes") or config.get("targets") or []
if isinstance(raw_targets, dict):
    iterable = []
    for name, value in raw_targets.items():
        item = dict(value) if isinstance(value, dict) else {"host": str(value)}
        item.setdefault("name", name)
        iterable.append(item)
else:
    iterable = raw_targets

wanted = {"remote_digital_ocean_2", "remote_digital_ocean_3", "remote_digital_ocean_4", "remote_linode_1"}
workers = []
for item in iterable:
    if not isinstance(item, dict):
        continue
    name = item.get("name") or item.get("id") or item.get("alias") or item.get("host")
    if name not in wanted:
        continue
    workers.append({
        "name": name,
        "host": item.get("host") or name,
        "user": item.get("user") or "invoker",
        "port": int(item.get("port") or 22),
        "enabled": True,
    })

payload = {"version": 1, "coordinator": "remote_digital_ocean_1", "workers": workers}
out_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
print(f"wrote {len(workers)} workers to {out_path}")
PY
fi

[[ "$NO_SSH" -eq 1 ]] && exit 0

WORKERS_FILE="${WRITE_WORKERS:-${BENCHMARK_ROOT:-/home/invoker/invoker-benchmarks}/config/workers.json}"
[[ -f "$WORKERS_FILE" ]] || die "Missing workers file: $WORKERS_FILE"

mapfile -t WORKERS < <(python3 - "$WORKERS_FILE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
for worker in data.get("workers", []):
    if worker.get("enabled", True):
        print(f"{worker.get('user', 'invoker')}@{worker.get('host', worker.get('name'))}\t{int(worker.get('port') or 22)}")
PY
)

for worker in "${WORKERS[@]}"; do
  IFS=$'\t' read -r target port <<<"$worker"
  echo "syncing credentials to $target"
  ssh -p "$port" "$target" "mkdir -p ~/.codex ~/.claude ~/.invoker ~/.ssh && chmod 700 ~/.ssh"
  for dir in "$HOME/.codex" "$HOME/.claude" "$HOME/.invoker"; do
    [[ -d "$dir" ]] || continue
    remote_dir="$(basename "$dir")"
    rsync -az --exclude 'sessions/' --exclude 'benchmark-scratch/' -e "ssh -p $port" "$dir/" "$target:~/$remote_dir/"
  done
  if [[ -d "$HOME/.ssh" ]]; then
    rsync -az --exclude '*.pub' --exclude 'known_hosts.old' -e "ssh -p $port" "$HOME/.ssh/" "$target:~/.ssh/"
    ssh -p "$port" "$target" "chmod 700 ~/.ssh && find ~/.ssh -type f -exec chmod 600 {} \\;"
  fi
done
