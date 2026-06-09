#!/usr/bin/env bash
# Submit a plan YAML to Invoker and execute it (headless mode).
# Uses the shared headless client so mutating submissions are owned by the
# standalone-capable owner selected in docs/context/inv-143/experiment-brief.md.
#
# Usage: ./submit-plan.sh <plan.yaml>
set -e

if [ -z "$1" ]; then
  echo "Usage: ./submit-plan.sh <plan.yaml>"
  exit 1
fi

PLAN_FILE="$1"
shift
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

if [ "$(uname)" = "Linux" ]; then
  export LIBGL_ALWAYS_SOFTWARE=1
fi

echo "==> Submitting plan: $PLAN_FILE"
if [ "$(uname)" = "Linux" ] && [ -z "${DISPLAY:-}" ]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "ERROR: headless Electron launch requires Xvfb when DISPLAY is not set." >&2
    echo "Install xvfb-run or set DISPLAY to an available X server." >&2
    exit 1
  fi
  ELECTRON_ENABLE_LOGGING=1 exec xvfb-run --auto-servernum ./run.sh --headless run "$PLAN_FILE" "$@"
fi

ELECTRON_ENABLE_LOGGING=1 exec ./run.sh --headless run "$PLAN_FILE" "$@"
