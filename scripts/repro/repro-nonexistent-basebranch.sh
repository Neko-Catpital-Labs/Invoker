#!/usr/bin/env bash
# Repro: Nonexistent baseBranch accepted
#
# This script runs the baseBranch validation test to demonstrate that:
# 1. Invalid baseBranch values (path traversal, empty, control chars) are accepted
# 2. The error surfaces only at runtime, after leaf work is done
#
# Before fix: Tests marked it.fails pass (invalid baseBranch accepted)
# After fix: Tests pass directly (invalid baseBranch rejected at parse time)

set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== Running baseBranch validation test ==="
pnpm --filter @invoker/workflow-core test -- --run repro-nonexistent-basebranch

echo ""
echo "=== Test completed ==="
