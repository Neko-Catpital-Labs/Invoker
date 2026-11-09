#!/usr/bin/env bash
# Headless Electron case scripts, shard 3 (case-4.*).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
export INVOKER_E2E_PRESERVE_FORGE_REPO_URL=1
exec bash "$ROOT/scripts/e2e-dry-run/run-all.sh" 'case-4.*.sh'
