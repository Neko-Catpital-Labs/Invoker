#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() {
  echo "[repro] FAIL: $1" >&2
  exit 1
}

echo "Repro: standalone owner web surface test must prove guard containment and startup ordering"

TEST_FILE="packages/app/src/__tests__/standalone-owner-web-surface.test.ts"
for needle in \
  "ownerServeGuardCloseBraceIdx" \
  "autoStartedWorkersIdx" \
  "launchDispatcherIdx" \
  "owner-serve must auto-start workers before exposing the web surface" \
  "owner-serve must start the launch dispatcher before exposing the web surface" \
  "headless owner web surface startup must stay inside the owner-serve guard"
  do
  if ! grep -Fq "$needle" "$TEST_FILE"; then
    fail "missing test invariant: $needle"
  fi
done

if pnpm --filter @invoker/app exec vitest run src/__tests__/standalone-owner-web-surface.test.ts; then
  echo "[repro] PASS: standalone owner web surface test defends guard containment and startup ordering"
else
  fail "targeted standalone owner web surface test failed"
fi
