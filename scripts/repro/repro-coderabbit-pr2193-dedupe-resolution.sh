#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

cd "$repo_root"
pnpm --dir packages/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "dedupes concurrent crabbox resolution for the same target"

echo "PASS: concurrent crabbox launches share one in-flight resolution"
