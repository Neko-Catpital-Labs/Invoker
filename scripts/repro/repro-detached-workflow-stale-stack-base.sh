#!/usr/bin/env bash
# Repro script: detach can leave a workflow based on a deleted Invoker stack branch.
#
# This runs the workflow-core regression that sets up:
#   1. an upstream workflow,
#   2. a downstream workflow whose baseBranch is a plan/* stack branch,
#   3. missing upstream branch metadata, matching stale/deleted lineage,
#   4. detachWorkflow(downstream, upstream).
#
# Broken behavior:
#   downstream keeps baseBranch=plan/deleted-upstream and merge checkout later fails.
#
# Correct behavior:
#   downstream clears the dependency and falls back to baseBranch=master.
#
# Usage:
#   bash scripts/repro/repro-detached-workflow-stale-stack-base.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_NAME="falls back managed stack base when detached upstream metadata is unavailable"

cd "$REPO_ROOT/packages/workflow-core"
pnpm exec vitest run src/__tests__/orchestrator-gates-and-workflow-admin.test.ts -t "$TEST_NAME"
