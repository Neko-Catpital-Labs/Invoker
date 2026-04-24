#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

exec timeout "${INVOKER_REPRO_TIMEOUT_SECONDS:-900}" \
  env \
    INVOKER_CHAOS_OVERLOAD_MODE=nightly \
    INVOKER_CHAOS_OVERLOAD_SCENARIO=owner-restart-loop-during-late-return-storm@nightly \
    ./scripts/e2e-chaos/run-overload.sh
