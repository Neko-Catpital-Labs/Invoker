#!/usr/bin/env bash
# Repro: Web /invoke masks thrown errors as "internal server error"
#
# This script runs the invoke error handling test to demonstrate that:
# 1. Validation/domain errors without .code are masked as "internal server error"
# 2. Error messages are not surfaced to the client
#
# Before fix: Tests marked it.fails pass (errors masked)
# After fix: Tests pass directly (errors surfaced with codes)

set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== Running invoke error handling test ==="
pnpm --filter @invoker/app test -- --run repro-invoke-error-mask

echo ""
echo "=== Test completed ==="
