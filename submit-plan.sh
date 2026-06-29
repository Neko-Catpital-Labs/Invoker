#!/usr/bin/env bash
# Submit a plan YAML to Invoker and execute it (headless mode).
# Uses the same Electron binary as the GUI to avoid ABI mismatches.
#
# Usage: ./submit-plan.sh <plan.yaml>
set -euo pipefail

if [ -z "${1:-}" ]; then
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

if [ ! -f "$PLAN_FILE" ]; then
  echo "Plan file not found: $PLAN_FILE" >&2
  exit 1
fi

# Unset ELECTRON_RUN_AS_NODE so Electron loads its full API (not plain Node mode).
# VS Code terminals set this, which breaks electron imports.
unset ELECTRON_RUN_AS_NODE

ELECTRON_ARGS=()
if [ "$(uname)" = "Linux" ]; then
  SANDBOX_BIN="$REPO_ROOT/node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox"
  # shellcheck disable=SC2086
  if ! stat -c '%U:%a' $SANDBOX_BIN 2>/dev/null | grep -q '^root:4755$'; then
    ELECTRON_ARGS+=(--no-sandbox)
  fi
fi

if [ "$(uname)" = "Linux" ]; then
  export LIBGL_ALWAYS_SOFTWARE=1
fi

echo "==> Submitting plan: $PLAN_FILE"
ELECTRON_ARGS+=(packages/app/dist/main.js --headless run "$PLAN_FILE")
./packages/app/node_modules/.bin/electron "${ELECTRON_ARGS[@]}"
