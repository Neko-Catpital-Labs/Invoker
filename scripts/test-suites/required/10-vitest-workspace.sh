#!/usr/bin/env bash
# Vitest in every workspace package + plan-to-invoker skill check.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
node scripts/agentic-context-score.mjs --self-test
bash scripts/test-scrub-handoff-artifacts.sh
bash scripts/test-plan-handoff-scrub-gate.sh
bash scripts/test-plan-to-invoker-skill.sh
export INVOKER_WORKSPACE_TEST_CONCURRENCY=1
exec bash scripts/workspace-test.sh
