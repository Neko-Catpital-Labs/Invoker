#!/usr/bin/env bash
# Repro: __merge__ task id impersonation
#
# This script runs the reserved task id prefix test to demonstrate that:
# 1. Task ids starting with __merge__ are currently accepted by parsePlan
# 2. Such ids bypass workflow scoping and can impersonate merge nodes
#
# Before fix: Tests marked it.fails pass (reserved prefix ids accepted)
# After fix: Tests pass directly (reserved prefix ids rejected)

set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== Running reserved task id prefix validation test ==="
pnpm --filter @invoker/workflow-core test -- --run repro-reserved-task-id-prefix

echo ""
echo "=== Test completed ==="
