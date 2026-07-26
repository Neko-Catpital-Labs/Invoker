#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_root"

if pnpm --dir packages/execution-engine exec vitest run \
  src/__tests__/ssh-executor.test.ts \
  -t "normalizes managed-workspace banner-only fallback errors into a generic startup failure"
then
  echo "PASS: managed-workspace banner-only fallback maps to the generic startup error"
else
  echo "FAIL: managed-workspace banner-only fallback leaked wrapper banners into the saved error" >&2
  exit 1
fi
