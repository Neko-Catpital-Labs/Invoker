#!/usr/bin/env bash
# Repro: mergeMode: no_op skips onFinish: merge / pull_request
#
# This script runs the no_op + onFinish validation test to demonstrate that:
# 1. mergeMode: no_op with onFinish: merge/pull_request is accepted
# 2. This causes the workflow to silently skip the merge/PR step
#
# Before fix: Tests marked it.fails pass (contradictory combo accepted)
# After fix: Tests pass directly (contradictory combo refused at parse time)

set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== Running no_op + onFinish mismatch test ==="
pnpm --filter @invoker/workflow-core test -- --run repro-noop-onfinish-mismatch

echo ""
echo "=== Test completed ==="
