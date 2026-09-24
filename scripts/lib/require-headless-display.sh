#!/usr/bin/env bash
invoker_require_headless_display() {
  local caller="${1:-$(basename "${BASH_SOURCE[1]:-e2e}")}"
  if command -v xvfb-run >/dev/null 2>&1; then
    return 0
  fi
  if [ "${INVOKER_ALLOW_HEADED_E2E:-}" = "1" ]; then
    return 0
  fi
  echo "${caller}: refusing to run Electron e2e without a virtual display." >&2
  echo "  xvfb-run was not found, so Playwright would open real windows on this desktop." >&2
  echo "  Run this suite on a Linux CI runner, or set INVOKER_ALLOW_HEADED_E2E=1 to opt in." >&2
  exit 1
}
