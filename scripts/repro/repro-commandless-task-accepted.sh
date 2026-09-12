#!/usr/bin/env bash
# Repro: Command-less / prompt-less task accepted
#
# This script runs the command-less task validation test to demonstrate that:
# 1. Tasks with neither command nor prompt are currently accepted by parsePlan
# 2. Such tasks cannot run and will stay pending forever
#
# Before fix: Tests marked it.fails pass (underlying test fails, showing the bug)
# After fix: Tests pass directly (tasks without command/prompt are rejected)

set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== Running command-less task validation test ==="
pnpm --filter @invoker/workflow-core test -- --run repro-commandless-task-accepted

echo ""
echo "=== Test completed ==="
