#!/usr/bin/env bash
# CodeRabbit PR #1527 — Bypass Crabbox refresh when attaching to a live executor.
#
# Finding: when the embedded terminal attaches to a still-running Crabbox SSH
# task (main.ts already holds a `liveHandle`), `resolveTaskTerminalSpec` still
# ran a `crabbox status` refresh. A transient status failure, expired persisted
# lease, or missing CLI would refuse to open a terminal for an actually running
# task, even though a live executor was available to attach to.
#
# Fix: pass the live executor into `resolveTaskTerminalSpec`; when present, skip
# the Crabbox lease refresh (and the static SSH re-resolution) and attach to it
# directly. Cold restore after restart keeps refreshing.
#
# This repro drives the guard test that asserts the live-attach path never runs
# the refresh runner. On buggy code the refusal makes the test fail (non-zero);
# on fixed code it passes (zero).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

TEST_FILE="src/__tests__/open-terminal.test.ts"
TEST_NAME="attaches to a live executor without refreshing the Crabbox lease for a running task"

echo "==> repro: live-attach must not refresh the Crabbox lease"
echo "    package : @invoker/app"
echo "    test    : $TEST_NAME"

set +e
pnpm --filter @invoker/app exec vitest run --reporter dot -t "$TEST_NAME" "$TEST_FILE"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  echo "FAIL: live-attach path still runs the Crabbox refresh and refuses to open the terminal (bug present)."
  exit 1
fi

echo "PASS: live executor attaches without a Crabbox lease refresh."
