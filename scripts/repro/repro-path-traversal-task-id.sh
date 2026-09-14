#!/usr/bin/env bash
# Repro: Path-traversal task id accepted
#
# This script runs the path-traversal task id test to demonstrate that:
# 1. Task ids with "..", "/", or "\\" are currently accepted by parsePlan
# 2. Such ids can escape intended directory scope when concatenated to paths
#
# Before fix: Tests marked it.fails pass (underlying test fails, showing the bug)
# After fix: Tests pass directly (path-unsafe task ids are rejected)

set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== Running path-traversal task id validation test ==="
pnpm --filter @invoker/workflow-core test -- --run repro-path-traversal-task-id

echo ""
echo "=== Test completed ==="
