#!/usr/bin/env bash
# Generated battle-test matrix for local + GUI-owner chaos scenarios.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
exec bash "$ROOT/scripts/e2e-chaos/run-matrix.sh" "$@"
