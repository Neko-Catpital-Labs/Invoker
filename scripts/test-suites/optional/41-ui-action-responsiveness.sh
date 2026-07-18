#!/usr/bin/env bash
# Daily/extended UI action responsiveness battery (fat DB + interaction matrix).
# Not part of PR Playwright shards — see docs/architecture/ui-action-responsiveness-invariant.md
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

export INVOKER_PLAYWRIGHT_FILES="${INVOKER_PLAYWRIGHT_FILES:-e2e/ui-action-responsiveness-battery.spec.ts}"
export INVOKER_PLAYWRIGHT_RUN_LABEL="${INVOKER_PLAYWRIGHT_RUN_LABEL:-ui-action-responsiveness}"

exec bash "$ROOT/scripts/test-suites/optional/40-playwright-app.sh" "$@"
