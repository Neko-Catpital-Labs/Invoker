#!/usr/bin/env bash
set -euo pipefail

PKG="${1:?package name required (e.g. @invoker/workflow-graph)}"
SCRIPT="${2:?pnpm script name required (e.g. test)}"
shift 2 || true

ROOT="${BUILD_WORKSPACE_DIRECTORY:-}"
if [ -z "$ROOT" ]; then
  echo "BUILD_WORKSPACE_DIRECTORY is unset. Pass --test_env=BUILD_WORKSPACE_DIRECTORY=\$PWD (or use scripts/bazel/parity.sh)." >&2
  exit 2
fi

cd "$ROOT"
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found on PATH=$PATH" >&2
  exit 127
fi

exec pnpm --filter "$PKG" "$SCRIPT" "$@"
