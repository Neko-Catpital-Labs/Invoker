#!/usr/bin/env bash
set -euo pipefail

list_electron_processes() {
  ps -axo pid=,command= | while read -r pid command; do
    if [ -z "${pid:-}" ] || [ "$pid" = "$$" ] || [ "$pid" = "${PPID:-}" ]; then
      continue
    fi

    case "$command" in
      *kill-all-electron.sh*)
        continue
        ;;
      *Electron.app/Contents/MacOS/Electron*|*"node "*scripts/electron.cjs*)
        printf '%s %s\n' "$pid" "$command"
        ;;
    esac
  done
}

kill_electron_processes() {
  local signal="$1"
  local processes
  processes="$(list_electron_processes)"
  if [ -z "$processes" ]; then
    return 0
  fi
  printf '%s\n' "$processes" | while read -r pid _; do
    kill "-$signal" "$pid" 2>/dev/null || true
  done
}

processes="$(list_electron_processes)"
if [ -z "$processes" ]; then
  echo "No Electron processes found"
  exit 0
fi

echo "Electron processes before kill:"
printf '%s\n' "$processes"

kill_electron_processes TERM

for _ in $(seq 1 10); do
  if [ -z "$(list_electron_processes)" ]; then
    echo "All Electron processes stopped"
    exit 0
  fi
  sleep 0.5
done

echo "Forcing SIGKILL on remaining Electron processes..."
kill_electron_processes KILL
sleep 0.5

processes="$(list_electron_processes)"
if [ -n "$processes" ]; then
  echo "Some Electron processes are still running:"
  printf '%s\n' "$processes"
  exit 1
fi

echo "All Electron processes killed"
