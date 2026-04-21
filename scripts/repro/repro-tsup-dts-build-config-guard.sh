#!/usr/bin/env bash
# Repro/proof: keep the original TS6307 tsup DTS regression fixed by enforcing
# that every tsup DTS package uses a dedicated non-composite tsconfig, then
# re-building the packages that originally exposed the failure class.
#
# Usage:
#   bash scripts/repro/repro-tsup-dts-build-config-guard.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "==> guard: every tsup DTS package uses a dedicated non-composite tsconfig"
node scripts/check-tsup-dts-build-config.mjs

echo
echo "==> direct regression checks for the original TS6307 packages"
pnpm --filter @invoker/runtime-domain build
pnpm --filter @invoker/runtime-adapters build
pnpm --filter @invoker/transport build

echo
echo "repro result:"
echo "- the repo guard confirms every tsup DTS package uses a dedicated build tsconfig"
echo "- runtime-domain, runtime-adapters, and transport still build successfully"
echo "- this keeps the original TS6307 class from silently drifting back in"
