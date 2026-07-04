#!/usr/bin/env bash
# Repro: Crabbox status sshPort must be a real TCP port before it is accepted.
#
# CodeRabbit PR #1401 (packages/execution-engine/src/crabbox-target-resolver.ts):
#   sshPort was accepted whenever `Number.isFinite(json.sshPort)` was true, which
#   admits 0, negatives, out-of-range (>65535), and non-integers. Any of these
#   yields an unusable SSH target at runtime instead of falling back sensibly.
#
# Fixed behavior:
#   Only integers in [1, 65535] are accepted from status or config; otherwise the
#   resolver falls back to config.port (when valid) then to the default port 22.
#
# Guarded by the vitest case below; this script fails (non-zero) on buggy code.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT/packages/execution-engine"

TEST_FILE="src/__tests__/crabbox-target-resolver.test.ts"
FILTER="rejects an out-of-range or non-integer sshPort"

echo "==> Repro: invalid sshPort (0/negative/non-integer/>65535) must fall back"
if pnpm exec vitest run "$TEST_FILE" -t "$FILTER"; then
  echo "PASS: invalid sshPort values are rejected and fall back to a valid port"
else
  echo "FAIL: invalid sshPort accepted, producing an unusable target (CodeRabbit PR#1401)" >&2
  exit 1
fi
