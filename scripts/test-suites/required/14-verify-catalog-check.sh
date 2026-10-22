#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"
CONTROL_INVOKER="skills/verify/control-invoker.mjs"
[[ -f "corpus/skills/verify/control-invoker.mjs" ]] && CONTROL_INVOKER="corpus/skills/verify/control-invoker.mjs"
node "$CONTROL_INVOKER" catalog --check
