#!/usr/bin/env bash
# Blocking repro for fix-intent cancellation and stale SSH metadata.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

export REPRO_TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-180}"
export INVOKER_REPRO_TIMEOUT_SECONDS="${INVOKER_REPRO_TIMEOUT_SECONDS:-600}"

if command -v xvfb-run >/dev/null 2>&1; then
  exec xvfb-run --auto-servernum \
    bash "$ROOT/scripts/repro/repro-fix-intent-cancellation-and-stale-ssh-metadata.sh" --expect fixed
fi

exec bash "$ROOT/scripts/repro/repro-fix-intent-cancellation-and-stale-ssh-metadata.sh" --expect fixed
