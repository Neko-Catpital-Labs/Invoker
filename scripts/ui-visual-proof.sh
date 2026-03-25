#!/usr/bin/env bash
set -euo pipefail

# Capture UI screenshots and video for the current working tree state.
#
# This script builds the UI + app, runs Playwright visual-proof tests, and
# saves screenshots + video to an output directory. It does NOT handle git
# checkouts or before/after comparisons — the caller orchestrates that.
#
# Usage:
#   scripts/ui-visual-proof.sh [--validate] [--label <name>] [--output-dir <dir>] [--spec <file>]
#
# Modes:
#   --validate    Run DOM snapshot tests (fast, no Electron needed)
#   [default]     Capture pixel screenshots via Playwright + Electron
#
# Options:
#   --label       Subdirectory name under output-dir (default: "capture")
#   --output-dir  Base directory for captures (default: packages/app/e2e/visual-proof)
#   --spec        Playwright spec file to run (default: visual-proof.spec.ts)
#   --skip-build  Skip the pnpm build step (useful when already built)
#
# Output structure (capture mode):
#   <output-dir>/<label>/
#     ├── empty-state.png
#     ├── dag-loaded.png
#     ├── task-running.png
#     ├── task-complete.png
#     ├── task-panel.png
#     └── walkthrough.webm

LABEL="capture"
OUTPUT_DIR="packages/app/e2e/visual-proof"
SPEC="visual-proof.spec.ts"
SKIP_BUILD=false
RESULTS_DIR="packages/app/e2e/test-results"
VALIDATE=false

usage() {
  sed -n '3,/^$/p' "$0" | sed 's/^# \?//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --validate)   VALIDATE=true; shift ;;
    --label)      LABEL="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --spec)       SPEC="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --help|-h)    usage ;;
    *)            echo "Unknown option: $1" >&2; usage ;;
  esac
done

# --validate mode: run DOM snapshot tests and exit
if [[ "${VALIDATE}" == "true" ]]; then
  echo "[visual-proof] Running DOM snapshot tests..." >&2
  cd packages/ui && pnpm test -- --run src/__tests__/visual-proof-snapshots.test.tsx
  exit $?
fi

CAPTURE_DIR="${OUTPUT_DIR}/${LABEL}"

echo "[visual-proof] Capturing to ${CAPTURE_DIR}" >&2
mkdir -p "${CAPTURE_DIR}"

# Cleanup: wipe stale experiment worktrees and branches.
# DB cleanup is handled by tmpdir isolation in the E2E fixture.
echo "[visual-proof] Cleaning stale experiment state..." >&2
rm -rf "${HOME}/.invoker/worktrees"/* 2>/dev/null || true
git worktree prune 2>/dev/null || true
{ git for-each-ref --format='%(refname:short)' refs/heads/experiment/ 2>/dev/null | xargs -r -n 50 git branch -D 2>/dev/null; } || true

if [[ "${SKIP_BUILD}" == "false" ]]; then
  echo "[visual-proof] Building UI and app..." >&2
  pnpm --filter @invoker/ui build && pnpm --filter @invoker/app build
fi

echo "[visual-proof] Running Playwright: ${SPEC}" >&2
PLAYWRIGHT_EXIT=0
cd packages/app && CAPTURE_MODE="${LABEL}" CAPTURE_VIDEO=1 \
  xvfb-run --auto-servernum npx playwright test "${SPEC}" || PLAYWRIGHT_EXIT=$?
cd ../..

if [[ "${PLAYWRIGHT_EXIT}" -ne 0 ]]; then
  echo "[visual-proof] Playwright exited ${PLAYWRIGHT_EXIT} — collecting any screenshots produced" >&2
fi

# Move screenshots from the Playwright-internal capture dir to our output dir.
# captureScreenshot() in electron-app.ts writes to packages/app/e2e/visual-proof/<CAPTURE_MODE>/
# which is the same as CAPTURE_DIR when using default OUTPUT_DIR. When OUTPUT_DIR is overridden
# we need to move them.
PLAYWRIGHT_CAPTURE_DIR="packages/app/e2e/visual-proof/${LABEL}"
if [[ "${PLAYWRIGHT_CAPTURE_DIR}" != "${CAPTURE_DIR}" ]] && [[ -d "${PLAYWRIGHT_CAPTURE_DIR}" ]]; then
  cp "${PLAYWRIGHT_CAPTURE_DIR}"/*.png "${CAPTURE_DIR}/" 2>/dev/null || true
fi

# Copy video from test-results
find "${RESULTS_DIR}" -name '*.webm' -exec cp {} "${CAPTURE_DIR}/walkthrough.webm" \; 2>/dev/null || true

echo "[visual-proof] Captured files:" >&2
ls -la "${CAPTURE_DIR}/" >&2

SCREENSHOT_COUNT=$(find "${CAPTURE_DIR}" -name '*.png' 2>/dev/null | wc -l)
if [[ "${SCREENSHOT_COUNT}" -eq 0 ]]; then
  echo "[visual-proof] ERROR: No screenshots captured" >&2
  exit 1
fi

echo "[visual-proof] ${SCREENSHOT_COUNT} screenshot(s) captured" >&2
echo "${CAPTURE_DIR}"
