#!/usr/bin/env bash
# Regression: headless_query must time out instead of hanging forever when
# the owner is dead/unresponsive.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
bash "$ROOT/scripts/repro/repro-headless-query-hang-timeout.sh" --expect-fixed
