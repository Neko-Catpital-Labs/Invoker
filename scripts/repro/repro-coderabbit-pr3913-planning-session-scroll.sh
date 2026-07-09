#!/usr/bin/env bash
# Repro: the planning session list must be a bounded scroll region.
#
# CodeRabbit (PR #3913) flagged that `overflow-y-auto` alone on the planning
# session list container does not constrain its height. With height:auto the
# scroll region never engages; once sessions exceed the rail height the list
# overflows and is clipped by the ancestor `overflow-hidden` instead of
# scrolling. The container needs a definite height (h-full) so overflow-y-auto
# actually produces a scrollbar.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "==> Running planning-session bounded-scroll repro"
if pnpm --filter @invoker/ui exec vitest run src/__tests__/invoker-terminal.test.tsx -t "constrains the planning session list to a bounded scroll region"; then
  echo "PASS: planning session list has a definite height, so it scrolls instead of clipping."
else
  echo "FAIL: planning session list scroll region is unconstrained; long lists clip instead of scrolling." >&2
  exit 1
fi
