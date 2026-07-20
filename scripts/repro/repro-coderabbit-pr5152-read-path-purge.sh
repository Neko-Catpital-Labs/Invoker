#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "Repro: pending confirmation reads must stay read-only and lazily ignore expiry"
if pnpm --filter @invoker/data-store exec vitest run src/__tests__/slack-session-repository.test.ts; then
  echo "PASS: pending confirmation reads stay read-only and expiry is lazy"
else
  echo "FAIL: pending confirmation reads still require a write or expiry handling regressed"
  exit 1
fi
