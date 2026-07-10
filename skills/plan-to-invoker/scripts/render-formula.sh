#!/usr/bin/env bash
# Thin wrapper around render-formula.mjs (mirrors validate-plan.sh → .mjs).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/render-formula.mjs" "$@"
