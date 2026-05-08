#!/usr/bin/env bash
# Submit a plan YAML to Invoker and execute it (headless mode).
# Uses the same Electron binary as the GUI to avoid ABI mismatches.
#
# Usage: ./submit-plan.sh <plan.yaml>
set -e

if [ -z "$1" ]; then
  echo "Usage: ./submit-plan.sh <plan.yaml>"
  exit 1
fi

PLAN_FILE="$1"
CALLER_PWD="$(pwd)"
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

# Resolve plan path relative to caller's pwd if not absolute
if [[ "$PLAN_FILE" != /* ]]; then
  PLAN_FILE="$CALLER_PWD/$PLAN_FILE"
fi

# Unset ELECTRON_RUN_AS_NODE so Electron loads its full API (not plain Node mode).
# VS Code terminals set this, which breaks electron imports.
unset ELECTRON_RUN_AS_NODE

SANDBOX_FLAG=""
if [ "$(uname)" = "Linux" ]; then
  SANDBOX_BIN="$REPO_ROOT/node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox"
  # shellcheck disable=SC2086
  if ! stat -c '%U:%a' $SANDBOX_BIN 2>/dev/null | grep -q '^root:4755$'; then
    SANDBOX_FLAG="--no-sandbox"
  fi
fi

if [ "$(uname)" = "Linux" ]; then
  export LIBGL_ALWAYS_SOFTWARE=1
fi

# Auto-build if dist/main.js is missing
if [ ! -f packages/app/dist/main.js ]; then
  echo "==> packages/app/dist/main.js missing — building..." >&2
  pnpm --filter @invoker/app run build >&2
fi

# Rewrite repoUrl to file:// local checkout so plans work without network access
PLAN_EFFECTIVE="$PLAN_FILE"
if grep -q 'repoUrl:' "$PLAN_FILE" 2>/dev/null; then
  PLAN_TMP="$(mktemp "${TMPDIR:-/tmp}/submit-plan.XXXXXX")"
  trap 'rm -f "$PLAN_TMP"' EXIT
  sed "s|repoUrl:.*|repoUrl: file://$REPO_ROOT|" "$PLAN_FILE" > "$PLAN_TMP"
  PLAN_EFFECTIVE="$PLAN_TMP"
fi

echo "==> Submitting plan: $PLAN_FILE"
export INVOKER_HEADLESS_STANDALONE=1
./packages/app/node_modules/.bin/electron packages/app/dist/main.js $SANDBOX_FLAG --headless run "$PLAN_EFFECTIVE"
