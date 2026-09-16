#!/usr/bin/env bash
set -euo pipefail

ROOT="${BUILD_WORKSPACE_DIRECTORY:-}"
if [ -z "$ROOT" ]; then
  echo "BUILD_WORKSPACE_DIRECTORY is unset. Pass --test_env=BUILD_WORKSPACE_DIRECTORY=\$PWD." >&2
  exit 2
fi
cd "$ROOT"
exec "$@"
