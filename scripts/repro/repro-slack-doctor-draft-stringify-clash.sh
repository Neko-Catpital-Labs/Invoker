#!/usr/bin/env bash
# Repro: Slack stages doctor-approved YAML bytes even when yaml stringify
# would drop a blank line (DO1 thread 1787644363.867779 / #10248 clash).
#
# The underlying test uses `it.fails`, so this script exits 0 (green) while
# the clash bug is present: the callback throws, which satisfies the
# expected-failure assertion. Once a later fix slice makes stage+submit use
# the immutable doctor bytes, the callback will succeed, `it.fails` will
# itself start failing, and this script will exit non-zero -- that failure
# is the signal to remove `.fails` from the test.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> surfaces: doctor-approved blank-line YAML must stage Approve card and start_plan with those bytes"
pnpm --filter @invoker/surfaces exec vitest run \
  src/__tests__/slack-doctor-draft-stringify-clash.e2e.test.ts

echo "[repro] PASS: it.fails confirms the doctor-approved bytes are still dropped by stringify (bug still present)"
