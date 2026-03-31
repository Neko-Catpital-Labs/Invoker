#!/usr/bin/env bash
# Playwright + Electron (packages/app/e2e). Expects built app; e2e-dry-run usually built it earlier.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
exec pnpm --filter @invoker/app run test:e2e
