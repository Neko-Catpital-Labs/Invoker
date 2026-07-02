#!/usr/bin/env bash
# Headless Electron case scripts, shard 2b (case-2.10 through case-2.17).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
exec bash "$ROOT/scripts/e2e-dry-run/run-all.sh" 'case-2.1[0-7]-*.sh'
