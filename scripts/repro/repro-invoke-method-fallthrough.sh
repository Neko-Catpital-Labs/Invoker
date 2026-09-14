#!/usr/bin/env bash
# Repro: GET/HEAD /invoke serves SPA HTML
#
# This script runs the /invoke method validation test to demonstrate that:
# 1. GET/HEAD requests to /invoke fall through to static file handler
# 2. Instead of returning 405, they serve SPA HTML or check auth first
#
# Before fix: Tests marked it.fails pass (GET /invoke serves HTML)
# After fix: Tests pass directly (GET/HEAD /invoke return 405)

set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== Running /invoke method validation test ==="
pnpm --filter @invoker/app test -- --run repro-invoke-method-fallthrough

echo ""
echo "=== Test completed ==="
