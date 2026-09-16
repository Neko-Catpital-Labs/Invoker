#!/usr/bin/env bash
# Repro: executionAgent not validated at parse time for injection chars
#
# This script runs the executionAgent injection test to demonstrate that:
# 1. executionAgent values with shell metacharacters are accepted at parse
# 2. Values like "claude; id" are stored without validation
#
# Before fix: Tests marked it.fails pass (injection chars accepted)
# After fix: Tests pass directly (injection chars refused at parse time)

set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== Running executionAgent injection test ==="
pnpm --filter @invoker/workflow-core test -- --run repro-executionagent-injection

echo ""
echo "=== Test completed ==="
