#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #4241 (discussion r3566839020): the Home-return regression test
# only asserted react-flow fitView(), which WorkflowGraph can trigger on mount
# even if App stops issuing the explicit sidebar-home fitInitial command.
#
# The focused regression clicks the left-rail Home icon from the Workflows
# browser surface and asserts WorkflowGraph received a workflow-scoped
# fitInitial command with reason sidebar-home.
#   - Buggy code omits the command -> vitest fails -> repro exits non-zero.
#   - Fixed code issues the command -> vitest passes -> repro exits zero.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr4241-sidebar-home-fit.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] PR #4241: sidebar Home must issue a workflow fitInitial command."

if pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  src/__tests__/browser-surface-camera-resnap.test.tsx \
  -t "clicking the left-nav home icon returns to the workflow graph and issues the Home fit command" \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: sidebar Home sent WorkflowGraph the workflow fitInitial command with reason sidebar-home."
  exit 0
else
  status=$?
  echo "[repro] FAIL: sidebar Home returned home without proving the explicit workflow fitInitial command."
  cat "$LOG_FILE"
  exit "$status"
fi
