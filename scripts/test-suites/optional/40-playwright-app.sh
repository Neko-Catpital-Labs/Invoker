#!/usr/bin/env bash
# Playwright + Electron (packages/app/e2e). Expects built app; e2e-dry-run usually built it earlier.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

sanitize_label() {
  printf '%s' "$1" | tr -cs 'A-Za-z0-9._-' '-'
}

PLAYWRIGHT_ARGS=()
if [ -n "${INVOKER_PLAYWRIGHT_SHARD:-}" ]; then
  PLAYWRIGHT_ARGS+=( "--shard=${INVOKER_PLAYWRIGHT_SHARD}" )
elif [ -n "${INVOKER_PLAYWRIGHT_SHARD_INDEX:-}" ] && [ -n "${INVOKER_PLAYWRIGHT_SHARD_TOTAL:-}" ]; then
  PLAYWRIGHT_ARGS+=( "--shard=${INVOKER_PLAYWRIGHT_SHARD_INDEX}/${INVOKER_PLAYWRIGHT_SHARD_TOTAL}" )
fi

if [ -n "${INVOKER_PLAYWRIGHT_ARGS:-}" ]; then
  # Intentionally split on shell whitespace so CI can pass simple extra flags.
  # shellcheck disable=SC2206
  EXTRA_ARGS=( ${INVOKER_PLAYWRIGHT_ARGS} )
  PLAYWRIGHT_ARGS+=( "${EXTRA_ARGS[@]}" )
fi

RUN_LABEL="${INVOKER_PLAYWRIGHT_RUN_LABEL:-playwright-app}"
if [ -n "${INVOKER_PLAYWRIGHT_SHARD:-}" ]; then
  RUN_LABEL="${RUN_LABEL}-$(sanitize_label "${INVOKER_PLAYWRIGHT_SHARD}")"
elif [ -n "${INVOKER_PLAYWRIGHT_SHARD_INDEX:-}" ] && [ -n "${INVOKER_PLAYWRIGHT_SHARD_TOTAL:-}" ]; then
  RUN_LABEL="${RUN_LABEL}-$(sanitize_label "${INVOKER_PLAYWRIGHT_SHARD_INDEX}-of-${INVOKER_PLAYWRIGHT_SHARD_TOTAL}")"
fi
RUN_LABEL="$(sanitize_label "$RUN_LABEL")"

ARTIFACT_ROOT="$ROOT/.git/playwright-artifacts/$RUN_LABEL"
mkdir -p "$ARTIFACT_ROOT"

export INVOKER_E2E_BARE_REPO="${INVOKER_E2E_BARE_REPO:-/tmp/invoker-e2e-repo-${RUN_LABEL}.git}"

exec pnpm --filter @invoker/app exec xvfb-run --auto-servernum playwright test \
  --output "$ARTIFACT_ROOT/test-results" \
  "${PLAYWRIGHT_ARGS[@]}" \
  "$@"
