#!/usr/bin/env bash
# Repro script: stateful merge-gate retry from fixed integration tip.
#
# Distills the original merge-gate issue into a tiny git-only scenario and
# validates that the new stateful strategy works:
#   1) Task branches are created from upstream/master.
#   2) Descendant branches build on prior branches (chain topology).
#   3) Final merge-gate publish from fixed tip completes without conflicts.
#
# Usage:
#   ./scripts/repro/repro-stateful-merge-gate-retry.sh
#
# Exit codes:
#   0 - all assertions pass
#   1 - one or more assertions fail
set -euo pipefail

TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/repro-stateful-merge-XXXXXX")"
trap 'rm -rf "$TMPBASE"' EXIT

UPSTREAM="$TMPBASE/upstream.git"
FORK="$TMPBASE/fork.git"
SEED="$TMPBASE/seed"
DEV="$TMPBASE/dev"
GATE="$TMPBASE/gate"

FAILURES=0
pass() { echo "[PASS] $1"; }
fail() { echo "[FAIL] $1"; FAILURES=$((FAILURES + 1)); }

echo "==> Setup repos in $TMPBASE"
git init --bare "$UPSTREAM" >/dev/null 2>&1
git init --bare "$FORK" >/dev/null 2>&1

git clone "$UPSTREAM" "$SEED" >/dev/null 2>&1
git -C "$SEED" config user.email "repro@test.local"
git -C "$SEED" config user.name "Repro Bot"
cat > "$SEED/app.txt" <<'EOF'
line-1: base
line-2: base
EOF
git -C "$SEED" add app.txt
git -C "$SEED" commit -m "base commit on upstream/master" >/dev/null 2>&1
git -C "$SEED" push origin master >/dev/null 2>&1

# Mirror upstream into fork "origin" remote.
git -C "$SEED" remote add fork "$FORK"
git -C "$SEED" push fork master >/dev/null 2>&1

git clone "$FORK" "$DEV" >/dev/null 2>&1
git -C "$DEV" config user.email "repro@test.local"
git -C "$DEV" config user.name "Repro Bot"
git -C "$DEV" remote add upstream "$UPSTREAM"
git -C "$DEV" fetch upstream >/dev/null 2>&1

UPSTREAM_MASTER_SHA="$(git -C "$DEV" rev-parse upstream/master)"

echo "==> Create task branch chain"
# task-1 from upstream/master
git -C "$DEV" checkout -b experiment/task-1 upstream/master >/dev/null 2>&1
cat > "$DEV/app.txt" <<'EOF'
line-1: task-1 change
line-2: base
EOF
git -C "$DEV" add app.txt
git -C "$DEV" commit -m "task-1 change" >/dev/null 2>&1
git -C "$DEV" push -u origin experiment/task-1 >/dev/null 2>&1
TASK1_SHA="$(git -C "$DEV" rev-parse experiment/task-1)"

# task-2 from task-1 (descendant branch)
git -C "$DEV" checkout -b experiment/task-2 experiment/task-1 >/dev/null 2>&1
cat > "$DEV/app.txt" <<'EOF'
line-1: task-1 change
line-2: task-2 descendant change
EOF
git -C "$DEV" add app.txt
git -C "$DEV" commit -m "task-2 descendant change" >/dev/null 2>&1
git -C "$DEV" push -u origin experiment/task-2 >/dev/null 2>&1
TASK2_SHA="$(git -C "$DEV" rev-parse experiment/task-2)"

echo "==> Validate branch ancestry requirements"
TASK1_BASE="$(git -C "$DEV" merge-base experiment/task-1 upstream/master)"
if [ "$TASK1_BASE" = "$UPSTREAM_MASTER_SHA" ]; then
  pass "task-1 is based on upstream/master"
else
  fail "task-1 is not based on upstream/master"
fi

TASK2_BASE="$(git -C "$DEV" merge-base experiment/task-2 experiment/task-1)"
if [ "$TASK2_BASE" = "$TASK1_SHA" ]; then
  pass "task-2 builds directly on task-1"
else
  fail "task-2 does not build directly on task-1"
fi

echo "==> Simulate merge-gate AI fix in gate clone"
git clone "$FORK" "$GATE" >/dev/null 2>&1
git -C "$GATE" config user.email "repro@test.local"
git -C "$GATE" config user.name "Repro Bot"
git -C "$GATE" remote add upstream "$UPSTREAM"
git -C "$GATE" fetch --all >/dev/null 2>&1

git -C "$GATE" checkout -B ai/fixed upstream/master >/dev/null 2>&1
git -C "$GATE" merge --no-ff -m "Merge experiment/task-1" origin/experiment/task-1 >/dev/null 2>&1
git -C "$GATE" merge --no-ff -m "Merge experiment/task-2" origin/experiment/task-2 >/dev/null 2>&1

# AI-applied local reconciliation commit (this is the stateful anchor we must keep)
echo "ai reconciliation note" > "$GATE/ai-fix-note.txt"
git -C "$GATE" add ai-fix-note.txt
git -C "$GATE" commit -m "AI reconciliation follow-up" >/dev/null 2>&1
FIXED_INTEGRATION_SHA="$(git -C "$GATE" rev-parse HEAD)"

echo "==> Stateful publish-after-fix from fixed integration SHA"
git -C "$GATE" checkout --detach "$FIXED_INTEGRATION_SHA" >/dev/null 2>&1
git -C "$GATE" checkout -B plan/feature >/dev/null 2>&1

MERGED_COUNT=0
SKIPPED_COUNT=0
for BR in origin/experiment/task-1 origin/experiment/task-2; do
  if git -C "$GATE" merge-base --is-ancestor "$BR" HEAD >/dev/null 2>&1; then
    echo "  skip $BR (already ancestor)"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi
  echo "  merge $BR"
  git -C "$GATE" merge --no-ff -m "Merge $BR" "$BR" >/dev/null 2>&1
  MERGED_COUNT=$((MERGED_COUNT + 1))
done

if [ -f "$GATE/.git/MERGE_HEAD" ]; then
  fail "final merge left repository in conflicted merge state"
else
  pass "final merge completed without conflicts"
fi

git -C "$GATE" push -f origin plan/feature >/dev/null 2>&1

if git -C "$GATE" merge-base --is-ancestor "$FIXED_INTEGRATION_SHA" plan/feature >/dev/null 2>&1; then
  pass "plan/feature preserves the fixed integration anchor"
else
  fail "plan/feature does not preserve the fixed integration anchor"
fi

if [ -f "$GATE/ai-fix-note.txt" ]; then
  pass "AI reconciliation commit content is present in final feature branch"
else
  fail "AI reconciliation commit content missing from final feature branch"
fi

if git -C "$GATE" merge-base --is-ancestor "$TASK2_SHA" plan/feature >/dev/null 2>&1; then
  pass "descendant task branch commit chain is included in final branch"
else
  fail "descendant task branch commit chain missing from final branch"
fi

echo "==> Summary"
echo "  merged branches: $MERGED_COUNT"
echo "  skipped branches: $SKIPPED_COUNT"

if [ "$FAILURES" -eq 0 ]; then
  echo "All assertions passed."
  exit 0
fi

echo "$FAILURES assertion(s) failed."
exit 1
