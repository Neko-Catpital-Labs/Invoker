#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

exec timeout "${INVOKER_REPRO_TIMEOUT_SECONDS:-600}" \
  env INVOKER_CHAOS_OVERLOAD_SCENARIO=mixed-control-plane-storm \
  INVOKER_CHAOS_OVERLOAD_MODE=deterministic \
  ./scripts/e2e-chaos/run-overload.sh
