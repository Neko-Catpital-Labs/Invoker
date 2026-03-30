#!/usr/bin/env bash
# Vitest in every workspace package + plan-to-invoker skill check.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
exec pnpm test
