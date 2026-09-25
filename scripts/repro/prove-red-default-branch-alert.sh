#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/e2e-autofix-worker.test.ts -t "red default branch alert"; then
  echo "prove-red-default-branch-alert: ok"
  exit 0
fi

echo "prove-red-default-branch-alert: red-default-branch alert defect is present" >&2
exit 1
