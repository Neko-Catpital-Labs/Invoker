#!/usr/bin/env bash
# Repro: loading a new plan after starting a previous plan must reset App run controls.
#
# The buggy behavior leaves hasStarted=true in the shared plan-load path, so the
# newly uploaded plan hides Run and keeps Stop visible before it has started.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "==> Running CodeRabbit PR #2669 repro: reset run state on plan load"

if pnpm --filter @invoker/ui exec vitest run src/__tests__/app-launch.test.tsx -t 'resets run controls when uploading a new plan after start'; then
  echo "PASS: loading a new plan resets run controls."
else
  echo "FAIL: loading a new plan leaves stale started state; Run is hidden or Stop remains visible." >&2
  exit 1
fi
