#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pnpm --dir "$ROOT_DIR" --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "logs cleanup failure instead of success when resolver cannot stop"

echo "PASS: missing Crabbox resolver stop implementation is logged as cleanup failure"
