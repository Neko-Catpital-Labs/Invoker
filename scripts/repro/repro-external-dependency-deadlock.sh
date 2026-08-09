#!/usr/bin/env bash
#
# Repro: the 2026-08-05/06 production incident left 45 real workflows pending
# for 2+ days with free execution capacity after their shared upstream workflow
# was invalidated and then abandoned. PR #7704 added the original failing proof:
# https://github.com/Neko-Catpital-Labs/Invoker/pull/7704
#
# PR #8058 fixes the guarded invariant by detaching direct downstream external
# dependency gates when an abandoned upstream workflow is cancelled, while
# invalidation paths that can still rerun the upstream keep downstream gated:
# https://github.com/Neko-Catpital-Labs/Invoker/pull/8058
#
# Exit-code contract: exits 0 only when the post-#8058 invariant holds; exits
# non-zero on the pre-#8058 deadlock behavior.
#
# Usage: bash scripts/repro/repro-external-dependency-deadlock.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPRO_SPEC="packages/workflow-core/src/__tests__/repro-permanent-external-dependency-deadlock.test.ts"

cd "$REPO_ROOT"

if ! grep -q "detaches downstream from an invalidated upstream when that upstream is cancelled and abandoned" "$REPRO_SPEC" \
  || ! grep -q "keeps a genuinely-still-invalid upstream gate blocking its downstream" "$REPRO_SPEC"; then
  echo "[repro] FAIL: fixed post-#8058 proof assertions are missing; pre-#8058 tests can false-green by expecting the deadlock."
  exit 1
fi

echo "[repro] running external dependency deadlock proof ..."
if ! pnpm --filter @invoker/workflow-core exec vitest run \
  src/__tests__/repro-permanent-external-dependency-deadlock.test.ts \
  src/__tests__/cross-workflow-cascade.test.ts \
  src/__tests__/cross-workflow-cascade-command-service-e2e.test.ts; then
  echo "[repro] FAIL: external dependency deadlock invariant did not hold."
  exit 1
fi

echo "[repro] fixed: abandoned upstream cancellation releases direct downstream external-dependency gates."
