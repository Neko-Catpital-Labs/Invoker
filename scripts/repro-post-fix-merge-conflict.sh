#!/usr/bin/env bash
set -euo pipefail

# Reproduction script: demonstrates the bug where fixing a consolidation conflict
# on clean master doesn't prevent the conflict from reappearing during publish.

TEMP_DIR=$(mktemp -d)
trap "rm -rf '$TEMP_DIR'" EXIT

cd "$TEMP_DIR"
echo "Working in: $TEMP_DIR"
echo

# Step 1: Initialize repo with base file
git init -q
git config user.name "Test User"
git config user.email "test@example.com"

cat > e2e-visual-proof.spec.ts << 'EOF'
import { test, expect } from '@playwright/test';

test('visual proof', async ({ page }) => {
  // Original content
  await page.goto('/');
  await expect(page).toHaveScreenshot();
});
EOF

git add e2e-visual-proof.spec.ts
git commit -q -m "Initial commit"
echo "✓ Created base file on master"

# Step 2: Create task-a that modifies the file
git checkout -q -b experiment/task-a
cat > e2e-visual-proof.spec.ts << 'EOF'
import { test, expect } from '@playwright/test';

test('visual proof', async ({ page }) => {
  // Task A: Add feature A
  await page.goto('/');
  await page.click('#feature-a-button');
  await expect(page).toHaveScreenshot();
});
EOF
git add e2e-visual-proof.spec.ts
git commit -q -m "Task A: Add feature A test"
echo "✓ Created experiment/task-a with modification"

# Step 3: Create task-b that conflicts with task-a
git checkout -q master
git checkout -q -b experiment/task-b
cat > e2e-visual-proof.spec.ts << 'EOF'
import { test, expect } from '@playwright/test';

test('visual proof', async ({ page }) => {
  // Task B: Add feature B (conflicts with A)
  await page.goto('/');
  await page.click('#feature-b-button');
  await expect(page).toHaveScreenshot();
});
EOF
git add e2e-visual-proof.spec.ts
git commit -q -m "Task B: Add feature B test"
echo "✓ Created experiment/task-b with conflicting modification"

# Step 4: Simulate consolidation failure
git checkout -q master
echo
echo "=== Simulating consolidateAndMergeImpl ==="
git merge --no-ff -q experiment/task-a -m "Merge task-a"
echo "✓ Merged task-a successfully"

if git merge --no-ff experiment/task-b -m "Merge task-b" 2>/dev/null; then
  echo "✗ UNEXPECTED: task-b merged without conflict"
  exit 1
fi
echo "✓ Merge task-b CONFLICTS (expected)"

git merge --abort
echo "✓ Aborted merge (state after consolidateAndMergeImpl failure)"

# Step 5: Simulate fix-with-claude on clean HEAD (BUGGY approach)
echo
echo "=== Simulating BUGGY fix: edit on clean master without resolving conflict ==="
cat > e2e-visual-proof.spec.ts << 'EOF'
import { test, expect } from '@playwright/test';

test('visual proof', async ({ page }) => {
  // Claude's fix: combined features (but not via merge resolution!)
  await page.goto('/');
  await page.click('#feature-a-button');
  await page.click('#feature-b-button');
  await expect(page).toHaveScreenshot();
});
EOF
git add e2e-visual-proof.spec.ts
git commit -q -m "fix: combine features A and B"
FIX_COMMIT=$(git rev-parse HEAD)
echo "✓ Applied fix as new commit: $FIX_COMMIT"

# Step 6: Simulate publishAfterFixImpl with buggy approach
echo
echo "=== Simulating publishAfterFixImpl with BUGGY fix ==="
git checkout -q -b feature/buggy-attempt
echo "✓ Created feature branch from master (includes fix)"

git merge --no-ff -q experiment/task-a -m "Merge task-a" 2>/dev/null || true
echo "✓ Merged task-a"

if git merge --no-ff experiment/task-b -m "Merge task-b" 2>/dev/null; then
  echo "✗ BUG NOT REPRODUCED: task-b merged without conflict"
  exit 1
fi
echo "✓ BUG REPRODUCED: Merge task-b CONFLICTS AGAIN (even after fix!)"
git merge --abort
echo

# Step 7: Demonstrate the FIX
echo "=== Demonstrating CORRECT fix: actually resolve the conflict via merge ==="
git checkout -q master
git reset -q --hard HEAD~1  # Remove the buggy fix commit
echo "✓ Reset to state before fix"

# Now properly merge task-b by resolving the conflict
git merge --no-ff experiment/task-b -m "Merge task-b" 2>/dev/null || {
  echo "✓ Conflict occurred, now resolving..."
  # Resolve by taking both features
  cat > e2e-visual-proof.spec.ts << 'EOF'
import { test, expect } from '@playwright/test';

test('visual proof', async ({ page }) => {
  // Resolved: both features
  await page.goto('/');
  await page.click('#feature-a-button');
  await page.click('#feature-b-button');
  await expect(page).toHaveScreenshot();
});
EOF
  git add e2e-visual-proof.spec.ts
  git commit -q --no-edit
  echo "✓ Resolved conflict and completed merge"
}

# Step 8: Simulate publishAfterFixImpl with correct fix
echo
echo "=== Simulating publishAfterFixImpl with CORRECT fix ==="
git checkout -q -b feature/correct-attempt

# Check if task-a is already merged
if git merge-base --is-ancestor experiment/task-a HEAD; then
  echo "✓ task-a already merged (ancestor of HEAD), skipping"
else
  git merge --no-ff -q experiment/task-a -m "Merge task-a"
  echo "✓ Merged task-a"
fi

# Check if task-b is already merged
if git merge-base --is-ancestor experiment/task-b HEAD; then
  echo "✓ task-b already merged (ancestor of HEAD), skipping"
else
  if git merge --no-ff experiment/task-b -m "Merge task-b" 2>/dev/null; then
    echo "✗ UNEXPECTED: task-b should already be merged"
    exit 1
  else
    echo "✗ FAIL: task-b still conflicts"
    exit 1
  fi
fi

echo
echo "=== SUCCESS ==="
echo "✓ Bug reproduced: editing on clean master doesn't prevent conflict"
echo "✓ Fix demonstrated: actually merging the conflicting branch resolves it"
echo "✓ publishAfterFixImpl succeeds when ancestor check prevents re-merge"
