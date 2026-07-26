#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "Repro: removed headless aliases must fail before Electron boots"
if pnpm --filter @invoker/app exec vitest run src/__tests__/headless-client.test.ts --testNamePattern="rejects removed aliases before booting Electron"; then
  echo "PASS: removed aliases are rejected before Electron boot"
else
  echo "FAIL: a removed alias still reached the Electron boot path"
  exit 1
fi
