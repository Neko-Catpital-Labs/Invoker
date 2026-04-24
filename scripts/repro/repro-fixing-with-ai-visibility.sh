#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

exec timeout "${INVOKER_REPRO_TIMEOUT_SECONDS:-300}" \
  env INVOKER_CHAOS_OVERLOAD_SCENARIO=fixing-with-ai-visibility \
  ./scripts/e2e-chaos/run-overload.sh
