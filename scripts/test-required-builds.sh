#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Static: required-builds.sh must build @invoker/contracts. This package's
# dist is loaded directly (not just re-exported through a bundler) by
# scripts/headless-ipc.js's CONTRACTS_DIST path, so a stale or missing
# contracts build breaks that script silently -- see the incident where
# packages/contracts/dist/index.js sat 12 days stale on a deployed host,
# missing resolveActiveInvokerProfileEnv entirely, because no build step
# anywhere ever rebuilt it.
grep -q '^pnpm --filter @invoker/contracts build$' scripts/required-builds.sh || {
  echo "FAIL: scripts/required-builds.sh no longer builds @invoker/contracts" >&2
  exit 1
}
echo "PASS: required-builds.sh builds @invoker/contracts"

# Behavioral: prove the build this script runs actually produces a dist
# that exports what headless-ipc.js needs. A grep-only check could pass
# even if the filter target is spelled correctly but the underlying build
# silently fails or emits a stale artifact.
rm -f packages/contracts/dist/index.js
pnpm --filter @invoker/contracts build >/tmp/test-required-builds-contracts.log 2>&1 || {
  echo "FAIL: pnpm --filter @invoker/contracts build failed" >&2
  cat /tmp/test-required-builds-contracts.log >&2
  exit 1
}
test -f packages/contracts/dist/index.js || {
  echo "FAIL: packages/contracts/dist/index.js was not produced" >&2
  exit 1
}
grep -q 'resolveActiveInvokerProfileEnv' packages/contracts/dist/index.js || {
  echo "FAIL: built packages/contracts/dist/index.js does not export resolveActiveInvokerProfileEnv" >&2
  exit 1
}
echo "PASS: pnpm --filter @invoker/contracts build produces a dist exporting resolveActiveInvokerProfileEnv"
