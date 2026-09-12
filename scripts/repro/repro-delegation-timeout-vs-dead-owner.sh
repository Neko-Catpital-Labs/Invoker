#!/usr/bin/env bash
# Repro: Concurrent CLI headless run false "owner not running"
#
# This script runs the delegation timeout classification test to demonstrate that:
# 1. Delegation timeout is not distinguished from "no owner" at the API level
# 2. Callers cannot differentiate busy owner (timeout) from dead owner (no-handler)
#
# Before fix: Tests marked it.fails pass (isTimeout/isNoHandler not exported)
# After fix: Tests pass directly (helpers exported for caller-side distinction)

set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== Running delegation timeout classification test ==="
pnpm --filter @invoker/app test -- --run repro-delegation-timeout-vs-dead-owner

echo ""
echo "=== Test completed ==="
