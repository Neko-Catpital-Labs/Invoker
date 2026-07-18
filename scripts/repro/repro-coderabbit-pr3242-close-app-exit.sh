#!/usr/bin/env bash
# Repro: closeApp must escalate based on actual Electron child exit, not ChildProcess.killed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TARGET="packages/app/e2e/planning-terminal-restart-persistence.spec.ts"

if grep -n "child\.killed" "$TARGET"; then
  echo "FAIL: closeApp still uses child.killed, which only means a signal was sent." >&2
  exit 1
fi

if ! grep -q "child.once('exit'" "$TARGET" || ! grep -q "child.once('close'" "$TARGET"; then
  echo "FAIL: closeApp does not track Electron child exit/close before SIGKILL escalation." >&2
  exit 1
fi

echo "PASS: closeApp escalates from SIGTERM using actual child exit/close state."
