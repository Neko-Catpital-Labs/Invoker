#!/usr/bin/env bash
set -euo pipefail

mode="${1:---expect-fixed}"

case "$mode" in
  --expect-fixed)
    pnpm --filter @invoker/ui exec vitest run src/__tests__/context-menu-e2e.test.tsx -t "workflow context menu shows backend accepted queued mutation|workflow mutation status poll updates queued to running and failed"
    ;;
  --expect-bug)
    pnpm --filter @invoker/ui exec vitest run src/__tests__/context-menu-e2e.test.tsx -t "workflow mutation status poll updates queued to running and failed" && {
      printf 'Expected old UI-delay bug, but backend-backed mutation status was visible.\n' >&2
      exit 1
    }
    ;;
  *)
    printf 'Usage: %s [--expect-fixed|--expect-bug]\n' "$0" >&2
    exit 2
    ;;
esac
