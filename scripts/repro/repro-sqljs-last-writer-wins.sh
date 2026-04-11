#!/usr/bin/env bash
# Repro: demonstrate historical sql.js multi-writer last-writer-wins behavior
# when owner boundary is bypassed and two writable adapters target one DB file.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

exec pnpm --filter @invoker/persistence test -- src/__tests__/owner-boundary.test.ts -t "reproduces last-writer-wins when two writable adapters bypass owner boundary"
