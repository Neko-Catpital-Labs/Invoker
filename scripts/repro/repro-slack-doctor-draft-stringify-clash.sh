#!/usr/bin/env bash
# Repro: Slack stages doctor-approved YAML bytes even when yaml stringify
# would drop a blank line (DO1 thread 1787644363.867779 / #10248 clash).
#
# Fails before the fix (no ready draft / stage throw swallowed).
# Passes after stage+submit use the immutable doctor bytes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> surfaces: doctor-approved blank-line YAML must stage Approve card and start_plan with those bytes"
pnpm --filter @invoker/surfaces exec vitest run \
  src/__tests__/slack-doctor-draft-stringify-clash.e2e.test.ts

echo "[repro] PASS: doctor-approved Slack plan bytes survive staging and Approve"
