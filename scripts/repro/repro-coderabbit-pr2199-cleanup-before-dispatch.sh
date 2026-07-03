#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pnpm --dir "$ROOT_DIR" --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "stops a completed lease before dispatching newly ready tasks"

echo "PASS: Crabbox cleanup runs before downstream SSH dispatch can reuse the target"
