#!/usr/bin/env bash
# Repro/proof: a merge task can stall before executeMergeNodeImpl(...) starts
# if an earlier merge completion is blocking the global completionChain.
#
# This wrapper runs:
# 1. the pre-merge completionChain stall repro
# 2. the merge-heartbeat repro that proves once merge execution starts,
#    heartbeat/lease renewal now works
#
# Usage:
#   bash scripts/repro/repro-merge-completion-chain-stall.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "==> repro: pre-merge completionChain stall"
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner.test.ts \
  --testNamePattern "a blocked first merge completion prevents a second merge completion from entering merge execution"

echo
echo "==> repro: merge heartbeat after merge execution starts"
bash scripts/repro/repro-merge-node-lease-expiry.sh

echo
echo "repro result:"
echo "- a blocked first merge completion prevents a second merge task from entering merge execution"
echo "- the blocked second task receives no merge-phase heartbeat renewals while waiting"
echo "- once merge execution actually starts, heartbeat/lease renewal works"
echo
echo "This distinguishes the new pre-merge completion handoff bug from the"
echo "already-fixed merge-heartbeat bug."
