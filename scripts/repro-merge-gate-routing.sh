#!/usr/bin/env bash
# Reproduction script for: downstream merge nodes incorrectly routed to publishAfterFix
#
# This script demonstrates the bug by:
# 1. Running the FIXED tests that validate correct routing behavior
# 2. Temporarily reverting the fix in api-server.ts to show the old (buggy) behavior
# 3. Re-running the tests to show they FAIL with the buggy code
#
# Usage: bash scripts/repro-merge-gate-routing.sh

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "=== Step 1: Run FIXED tests (should PASS) ==="
if cd packages/app && pnpm test -- --reporter=verbose 2>&1 | grep -E '(downstream merge|post-fix merge)'; then
  echo -e "${GREEN}PASS: Fixed tests pass as expected.${NC}"
else
  echo -e "${RED}FAIL: Fixed tests did not pass. Is the fix applied?${NC}"
  exit 1
fi
cd "$OLDPWD"

echo ""
echo "=== Step 2: Temporarily revert api-server.ts to buggy code ==="
APISERVER="packages/app/src/api-server.ts"
cp "$APISERVER" "$APISERVER.bak"

# Revert: remove the `&& t.id === taskId` guard and the negated filter
sed -i \
  's/t\.config\.isMergeNode && t\.id === taskId/t.config.isMergeNode/g' \
  "$APISERVER"
sed -i \
  's/!(t\.config\.isMergeNode && t\.id === taskId)/!t.config.isMergeNode/g' \
  "$APISERVER"

echo "Reverted api-server.ts to buggy filters."

echo ""
echo "=== Step 3: Run tests against BUGGY code (should FAIL) ==="
set +e
cd packages/app && pnpm test -- --reporter=verbose 2>&1 | grep -E '(downstream merge|post-fix merge|FAIL|✓|✗|×)'
TEST_EXIT=$?
set -e
cd "$OLDPWD"

echo ""
echo "=== Step 4: Restore fixed code ==="
mv "$APISERVER.bak" "$APISERVER"
echo "Restored api-server.ts."

if [ $TEST_EXIT -ne 0 ]; then
  echo -e "${GREEN}SUCCESS: Buggy code correctly fails the new tests — bug is reproduced.${NC}"
else
  echo -e "${RED}UNEXPECTED: Tests passed with buggy code. Check test assertions.${NC}"
  exit 1
fi
