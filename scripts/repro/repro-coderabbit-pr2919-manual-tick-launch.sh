#!/usr/bin/env bash
# Repro: external worker tick('manual') must return after launch, not after child exit.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TEST_NAME="returns from a manual tick after spawning the external process"

echo "==> Repro CodeRabbit PR #2919: tick('manual') returns after external worker launch"
set +e
timeout 8s pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/external-worker.test.ts \
  -t "$TEST_NAME"
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "PASS: tick('manual') returned without waiting for the external process to exit."
  exit 0
fi

if [[ "$status" -eq 124 ]]; then
  echo "FAIL: tick('manual') hung until the external process exited."
else
  echo "FAIL: external worker manual tick repro failed with status $status."
fi
exit "$status"
