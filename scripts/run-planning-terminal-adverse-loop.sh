#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

pnpm --filter @invoker/ui exec vitest run \
  src/__tests__/planning-terminal-startup-hydrate-race-repro.test.tsx \
  src/__tests__/planning-terminal-session-id-persist-repro.test.tsx \
  src/__tests__/planning-terminal-preset-switch-repro.test.tsx

pnpm --filter @invoker/app exec vitest run \
  src/__tests__/planning-terminal-restore-invariants.repro.test.ts
