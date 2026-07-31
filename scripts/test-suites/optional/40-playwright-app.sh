#!/usr/bin/env bash
# Playwright + Electron (packages/app/e2e). Expects built app; e2e-dry-run usually built it earlier.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

sanitize_label() {
  printf '%s' "$1" | tr -cs 'A-Za-z0-9._-' '-'
}

pick_xvfb_server_num() {
  local start="${INVOKER_PLAYWRIGHT_XVFB_SERVER_START:-99}"
  local end="${INVOKER_PLAYWRIGHT_XVFB_SERVER_END:-599}"
  local server_num
  for server_num in $(seq "$start" "$end"); do
    [ -e "/tmp/.X${server_num}-lock" ] && continue
    [ -e "/tmp/.X11-unix/X${server_num}" ] && continue
    printf '%s' "$server_num"
    return 0
  done
  return 1
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

if [ -n "${INVOKER_PLAYWRIGHT_FILES:-}" ]; then
  # Intentionally split on shell whitespace so CI can pass a static file list,
  # without expanding glob characters inside each file name.
  IFS=' ' read -ra PLAYWRIGHT_FILES <<< "${INVOKER_PLAYWRIGHT_FILES}"
  PLAYWRIGHT_ARGS+=( "${PLAYWRIGHT_FILES[@]}" )
fi

RUN_LABEL="${INVOKER_PLAYWRIGHT_RUN_LABEL:-playwright-app}"
if [ -n "${INVOKER_PLAYWRIGHT_SHARD:-}" ]; then
  RUN_LABEL="${RUN_LABEL}-$(sanitize_label "${INVOKER_PLAYWRIGHT_SHARD}")"
elif [ -n "${INVOKER_PLAYWRIGHT_SHARD_INDEX:-}" ] && [ -n "${INVOKER_PLAYWRIGHT_SHARD_TOTAL:-}" ]; then
  RUN_LABEL="${RUN_LABEL}-$(sanitize_label "${INVOKER_PLAYWRIGHT_SHARD_INDEX}-of-${INVOKER_PLAYWRIGHT_SHARD_TOTAL}")"
fi
RUN_LABEL="$(sanitize_label "$RUN_LABEL")"

ARTIFACT_ROOT="$(git rev-parse --git-path "playwright-artifacts/$RUN_LABEL")"
mkdir -p "$ARTIFACT_ROOT"

export INVOKER_E2E_BARE_REPO="${INVOKER_E2E_BARE_REPO:-/tmp/invoker-e2e-repo-${RUN_LABEL}.git}"
export INVOKER_PLAYWRIGHT_JSON_OUTPUT="${INVOKER_PLAYWRIGHT_JSON_OUTPUT:-$ARTIFACT_ROOT/results.json}"

if ! XVFB_SERVER_NUM="$(pick_xvfb_server_num)"; then
  echo "No free Xvfb server number found." >&2
  exit 1
fi

exec pnpm --filter @invoker/app exec xvfb-run --server-num "$XVFB_SERVER_NUM" playwright test \
  --output "$ARTIFACT_ROOT/test-results" \
  "${PLAYWRIGHT_ARGS[@]}" \
  "$@"
