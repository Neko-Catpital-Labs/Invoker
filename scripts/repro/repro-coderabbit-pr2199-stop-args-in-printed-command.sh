#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

pnpm --dir "$ROOT_DIR" --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "keeps the lease on failure and appends connect/stop commands"

echo "PASS: preserved Crabbox leases print the configured stopArgs in the stop command"
