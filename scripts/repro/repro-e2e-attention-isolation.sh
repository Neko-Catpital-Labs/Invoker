#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/packages/app"

echo "repro: hidden macOS E2E windows must stay inactive and use accessory presentation"
pnpm exec vitest run src/__tests__/app-bootstrap.test.ts src/__tests__/window-lifecycle.test.ts
echo "PASS: hidden E2E window keeps accessory policy and never takes focus"
