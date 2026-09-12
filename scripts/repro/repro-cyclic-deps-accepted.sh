#!/usr/bin/env bash
# Repro: Cyclic task deps accepted
#
# This script runs the cyclic dependency detection test to verify that:
# 1. parsePlan rejects cyclic dependencies
# 2. loadPlan rejects cyclic dependencies
# 3. Self-referential and transitive cycles are detected
# 4. Valid DAGs (no cycles) are accepted
#
# Before fix: Plans with cyclic dependencies were accepted, tasks stayed pending forever
# After fix: Cyclic plans are rejected at parse/load time with a clear error message

set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== Running cyclic dependency detection test ==="
pnpm --filter @invoker/workflow-core test -- --run repro-cyclic-deps-accepted

echo ""
echo "=== Test passed: Cyclic dependencies correctly rejected at load time ==="
