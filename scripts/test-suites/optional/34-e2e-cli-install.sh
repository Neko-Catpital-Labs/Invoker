#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

bash "$ROOT/scripts/test-e2e-cli-install-guard.sh"

if [ "$(node -p "String(process.config.variables.single_executable_application)")" = "true" ]; then
  exec bash "$ROOT/scripts/e2e-cli-install/run.sh" "$@"
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "==> node has single_executable_application=false; using the container lane instead"
  exec bash "$ROOT/scripts/e2e-cli-install/run.sh" --docker
fi

echo "FAIL: neither install lane is available here." >&2
echo "  node $(node -p "process.version") at $(node -p "process.execPath") reports single_executable_application=false," >&2
echo "  so \`pnpm run dist:cli\` cannot build release/ artifacts, and no Docker daemon is reachable for the container lane." >&2
exit 1
