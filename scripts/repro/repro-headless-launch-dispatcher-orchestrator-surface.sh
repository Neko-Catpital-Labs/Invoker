#!/usr/bin/env bash
# Repro: headless standalone LaunchDispatcher must receive the full orchestrator
# so capacity recovery APIs (startExecution / getExecutableReadyTasks) work.
#
#   --expect broken  → pass if the stale method subset is still present
#   --expect fixed   → pass if full orchestrator wiring is present (default)
#   --gate           → also run stranded ready top-up vitest
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

EXPECT=fixed
RUN_GATES=0
for arg in "$@"; do
  case "$arg" in
    --gate) RUN_GATES=1 ;;
    --expect) ;;
    --expect=*) EXPECT="${arg#--expect=}" ;;
    broken|fixed) EXPECT="$arg" ;;
  esac
done
# support `--expect broken`
prev=
for arg in "$@"; do
  if [[ "$prev" == "--expect" ]]; then EXPECT="$arg"; fi
  prev="$arg"
done

if [[ "$EXPECT" != "broken" && "$EXPECT" != "fixed" ]]; then
  echo "usage: $0 [--expect broken|fixed] [--gate]" >&2
  exit 2
fi

FILE=packages/app/src/headless-standalone-launch-dispatcher.ts
echo "repro: headless launch dispatcher orchestrator surface (expect=$EXPECT)"

has_full=0
has_subset=0
rg -n 'orchestrator:\s*headlessDeps\.orchestrator' "$FILE" >/dev/null && has_full=1
rg -n 'prepareTaskForNewAttempt:\s*\(taskId' "$FILE" >/dev/null && has_subset=1

if [[ "$EXPECT" == "broken" ]]; then
  if [[ "$has_subset" == "1" && "$has_full" == "0" ]]; then
    echo "PASS: headless still uses stale orchestrator subset (bug present)"
    exit 0
  fi
  echo "FAIL: expected broken subset wrap, got full=$has_full subset=$has_subset" >&2
  exit 1
fi

if [[ "$has_full" != "1" || "$has_subset" == "1" ]]; then
  echo "FAIL: headless LaunchDispatcher is not wired to the full orchestrator" >&2
  echo "      capacity recovery will not run in headless mode (full=$has_full subset=$has_subset)" >&2
  exit 1
fi

if [[ "$RUN_GATES" == "1" ]]; then
  cd packages/app
  pnpm exec vitest run src/__tests__/launch-dispatcher.test.ts -t "re-tops stranded ready"
fi
echo "PASS: headless owner passes full orchestrator into LaunchDispatcher"
