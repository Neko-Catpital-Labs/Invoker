#!/usr/bin/env bash
# Headless Electron case scripts (bash); builds app if dist is missing.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
exec bash "$ROOT/scripts/e2e-dry-run/run-all.sh"
