#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

exec timeout "${INVOKER_REPRO_TIMEOUT_SECONDS:-1800}" \
  env INVOKER_CHAOS_OVERLOAD_SCENARIO='late-return-rejection-under-storm@nightly' \
  INVOKER_CHAOS_OVERLOAD_MODE=nightly \
  INVOKER_CHAOS_OVERLOAD_TIMEOUT_SECONDS="${INVOKER_REPRO_TIMEOUT_SECONDS:-1800}" \
  ./scripts/e2e-chaos/run-overload.sh
