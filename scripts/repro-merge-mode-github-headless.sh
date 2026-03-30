#!/usr/bin/env bash
# Regression: UI/headless `set-merge-mode … github` must normalize to `external_review`
# and re-run the merge gate on the external-review path (not spurious `completed`).
#
# Why this escaped tests before:
# 1. YAML plans go through plan-parser, which maps `github` → `external_review`. Tests that
#    load PlanDefinition objects never persisted the raw UI value `github` on the workflow row.
# 2. TaskExecutor merge tests used `mergeMode: 'external_review'` only, not the legacy string
#    `github` as returned from SQLite after the TaskPanel `<option value="github">`.
# 3. There was no headless command mirroring IPC `set-merge-mode`, so bridge coverage could
#    not exercise “change mode → restart merge task” from a CLI-shaped entry point.
#
# This script:
#   A) Runs focused `vitest run <file>` cases (scoped; `pnpm test` alone would run the whole package).
#   B) Smoke-tests `--headless set-merge-mode` is registered (requires built dist/main.js).
#
# Note: A full `headless run` + `set-merge-mode` against a local file:// bare repo can hit
# unrelated merge-gate git issues in the worktree pool; the orchestrator/executor bridge test
# (Flow 9c) covers the merge-mode alias end-to-end with MockGit + a mock PR provider.
#
# Usage:
#   bash scripts/repro-merge-mode-github-headless.sh
#
# Exit codes:
#   0 — vitest regression tests passed; optional headless smoke passed (if dist exists).
#   1 — any step failed.
#
set -euo pipefail

INVOKER_MONO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INVOKER_MONO"

echo "==> merge-mode unit tests (packages/app)"
(cd packages/app && pnpm exec vitest run src/__tests__/merge-mode.test.ts)

echo "==> bridge Flow 9c: set-merge-mode github alias (packages/app)"
(cd packages/app && pnpm exec vitest run src/__tests__/bridge-orchestrator-executor.test.ts -t "Flow 9c")

echo "==> TaskExecutor legacy mergeMode=github (packages/executors)"
(cd packages/executors && pnpm exec vitest run src/__tests__/task-executor.test.ts -t "mergeMode=github")

MAIN_JS="$INVOKER_MONO/packages/app/dist/main.js"
if [[ -f "$MAIN_JS" ]]; then
  SANDBOX_FLAG=()
  if [[ "$(uname -s)" == "Linux" ]]; then
    SANDBOX_BIN=$(echo "$INVOKER_MONO"/node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox 2>/dev/null | head -1)
    if [[ -n "${SANDBOX_BIN:-}" ]] && ! stat -c '%U:%a' "$SANDBOX_BIN" 2>/dev/null | grep -q '^root:4755$'; then
      SANDBOX_FLAG=(--no-sandbox)
    fi
  fi
  ELECTRON="$INVOKER_MONO/packages/app/node_modules/.bin/electron"
  echo "==> headless set-merge-mode smoke (expect error text for missing args)"
  TMPERR="$(mktemp)"
  trap 'rm -f "$TMPERR"' EXIT
  set +e
  # shellcheck disable=SC2086
  "$ELECTRON" "$MAIN_JS" ${SANDBOX_FLAG[@]:-} --headless set-merge-mode >"$TMPERR" 2>&1
  set -e
  if ! grep -q 'Missing arguments' "$TMPERR" || ! grep -q 'set-merge-mode' "$TMPERR"; then
    echo "FAIL: expected Missing arguments + set-merge-mode in stderr/stdout" >&2
    cat "$TMPERR" >&2 || true
    exit 1
  fi
  echo "==> headless smoke OK"
else
  echo "==> skip headless smoke (no $MAIN_JS — run: pnpm --filter @invoker/app build)"
fi

echo ""
echo "PASS: merge-mode github alias regression checks"
