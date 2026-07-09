#!/usr/bin/env bash
# Run all e2e-dry-run case scripts (bash + headless Electron). Exit non-zero if any fail.
# This suite runs ONLY headless tests — no Playwright/UI tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$ROOT/scripts/e2e-dry-run/lib/common.sh"
invoker_e2e_ensure_app_built

# Start one shared Xvfb instance for the whole shard on headless Linux. This
# avoids per-Electron-invocation xvfb-run startup overhead (which races with
# timing-sensitive cases) and also prevents crashes inside scripts that bypass
# the runElectronHeadless wrapper (e.g. headless_query in headless-lib.sh,
# which spawns the Electron binary directly). Once DISPLAY is exported the
# fallback `xvfb-run` paths in submit-plan.sh and headless-client.ts become
# no-ops because they only engage when DISPLAY is unset.
SHARED_XVFB_PID=""
if [ "$(uname)" = "Linux" ] && [ -z "${DISPLAY:-}" ] && command -v Xvfb >/dev/null 2>&1; then
  display_num=99
  while [ "$display_num" -lt 200 ] && [ -e "/tmp/.X11-unix/X${display_num}" ]; do
    display_num=$((display_num + 1))
  done
  Xvfb ":${display_num}" -screen 0 1024x768x24 -nolisten tcp >/tmp/invoker-shared-xvfb.log 2>&1 &
  SHARED_XVFB_PID=$!
  export DISPLAY=":${display_num}"
  # Wait briefly for the Xvfb socket to appear.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -e "/tmp/.X11-unix/X${display_num}" ] && break
    sleep 0.2
  done
  if ! [ -e "/tmp/.X11-unix/X${display_num}" ]; then
    echo "WARN: shared Xvfb on DISPLAY=${DISPLAY} did not become ready in time; falling back to per-call xvfb-run" >&2
    kill "$SHARED_XVFB_PID" 2>/dev/null || true
    wait "$SHARED_XVFB_PID" 2>/dev/null || true
    SHARED_XVFB_PID=""
    unset DISPLAY
  else
    echo "==> e2e: started shared Xvfb on DISPLAY=${DISPLAY} (pid=${SHARED_XVFB_PID})"
  fi
fi

cleanup_shared_xvfb() {
  if [ -n "${SHARED_XVFB_PID:-}" ]; then
    kill "$SHARED_XVFB_PID" 2>/dev/null || true
    wait "$SHARED_XVFB_PID" 2>/dev/null || true
    SHARED_XVFB_PID=""
  fi
}
trap cleanup_shared_xvfb EXIT

shopt -s nullglob
cases=()
if [ "$#" -gt 0 ]; then
  for pattern in "$@"; do
    matches=( "$ROOT/scripts/e2e-dry-run/cases"/$pattern )
    if [ "${#matches[@]}" -eq 0 ]; then
      echo "No case scripts matched pattern: $pattern"
      exit 1
    fi
    cases+=( "${matches[@]}" )
  done
else
  cases=( "$ROOT/scripts/e2e-dry-run/cases/"*.sh )
fi
if [ "${#cases[@]}" -eq 0 ]; then
  echo "No case scripts in scripts/e2e-dry-run/cases/"
  exit 1
fi

failed=0
passed=0
for c in "${cases[@]}"; do
  echo ""
  echo "======== $(basename "$c") ========"
  if bash "$c"; then
    passed=$((passed + 1))
  else
    echo "FAILED: $c"
    failed=$((failed + 1))
  fi
done

# Final cleanup: prune worktrees created during tests.
git worktree prune 2>/dev/null || true

echo ""
echo "e2e-dry-run: $passed passed, $failed failed (${#cases[@]} total)"
if [ "$failed" -ne 0 ]; then
  exit 1
fi
exit 0
