#!/usr/bin/env bash
# Generated overload chaos suite for saturation and mixed-operation headless scenarios.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
exec bash "$ROOT/scripts/e2e-chaos/run-overload.sh" "$@"
