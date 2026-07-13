#!/usr/bin/env bash
set -euo pipefail

# Repro: two coupled UI bugs with one root cause.
#
# Symptoms (packages/ui/src/App.tsx):
#   1. Right-clicking a task and reaching for the "More" section (Recreate /
#      rebase actions) fails — the open context menu blinks shut mid-interaction.
#   2. After selecting a workflow, the task graph "suddenly changes to something
#      else" and the UI thrashes.
#
# Root cause: during transient task-graph churn (a snapshot resync, or a
# recreate/rebase teardown storm) the selected workflow briefly drops out of the
# live graph (absent from the workflow map with zero tasks). The auto-select
# effect and the browser-surface reconciliation effect reacted by reassigning
# the selection to whichever workflow sorted first — switching the task graph
# and calling setContextMenu(null), which tore down the open menu. The
# right-clicked task also briefly left the task map, so contextMenuTask went
# null and unmounted the menu on its own.
#
# Fix: hold an explicit workflow selection through the transient gap (a grace
# window, SELECTED_WORKFLOW_VANISH_GRACE_MS) before treating the workflow as
# gone, and hold the last-known task for an open context menu so a transient
# task-map gap does not tear it down.
#
# This regression test fails on the pre-fix code (the mini-DAG switches to the
# other workflow and the menu disappears) and passes with the fix.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

exec pnpm --filter @invoker/ui exec vitest run \
  "$ROOT/packages/ui/src/__tests__/selected-workflow-selection-steal-repro.test.tsx"
