#!/usr/bin/env bash
# Blocking repro bundle for the fix-intent cancellation / stale-lineage stack.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

export REPRO_TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-180}"
export INVOKER_REPRO_TIMEOUT_SECONDS="${INVOKER_REPRO_TIMEOUT_SECONDS:-600}"

exec xvfb-run --auto-servernum \
  bash "$ROOT/scripts/repro/repro-fix-intent-cancellation-stack.sh" --expect fixed
