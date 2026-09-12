#!/usr/bin/env bash
# Repro: 413 then keep-alive ECONNRESET
#
# This script runs the 413 keep-alive test to verify that:
# 1. A 413 response includes Connection: close header
# 2. A subsequent request on the same HTTP agent does not fail with ECONNRESET
#
# Before fix: Second request fails with ECONNRESET because req.destroy() dropped the socket
# After fix: Second request succeeds because we use req.resume() and Connection: close

set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== Running 413 keep-alive ECONNRESET test ==="
pnpm --filter @invoker/app test -- --run web-bridge-413

echo ""
echo "=== Test passed: 413 response correctly handles keep-alive connections ==="
