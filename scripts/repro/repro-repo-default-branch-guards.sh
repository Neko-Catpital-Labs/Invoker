#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$REPO_ROOT/packages/workflow-core"

TEST_FILE="src/__tests__/repo-default-branch.test.ts"
DETACH_FILE="src/__tests__/orchestrator-gates-and-workflow-admin.test.ts"
DETACH_TEST="blocks detach when target workflow repoUrl is missing"

echo "==> Running default-branch helper proof"
pnpm exec vitest run "$TEST_FILE"

echo
echo "==> Running missing-repoUrl detach guard proof"
pnpm exec vitest run "$DETACH_FILE" -t "$DETACH_TEST"

echo
echo "[repro] PASS: default-branch helper redacts credentials, handles dash-prefixed repo paths, and detach refuses to mutate workflows without repoUrl."
