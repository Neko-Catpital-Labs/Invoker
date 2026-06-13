#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

bash scripts/e2e-dry-run/run-all.sh case-2.13-rebase-recreate-coalesced.sh
pnpm run check:mutation-boundary

echo "mutation migration proof passed"
