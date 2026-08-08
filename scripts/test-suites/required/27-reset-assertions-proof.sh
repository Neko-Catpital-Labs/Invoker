#!/usr/bin/env bash
# Required proof coverage for reset postcondition assertions.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

exec bash scripts/repro/prove-reset-assertions.sh
