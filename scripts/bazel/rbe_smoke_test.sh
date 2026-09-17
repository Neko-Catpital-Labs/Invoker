#!/usr/bin/env bash
set -euo pipefail

if [ -n "${BUILD_WORKSPACE_DIRECTORY:-}" ] && [ -d "$BUILD_WORKSPACE_DIRECTORY" ]; then
  echo "rbe_smoke_test ran where the CI checkout exists ($BUILD_WORKSPACE_DIRECTORY); expected a remote executor" >&2
  exit 1
fi
echo "rbe_smoke_test ran remotely on $(uname -srm)"
