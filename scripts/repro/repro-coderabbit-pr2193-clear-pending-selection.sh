#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

cd "$repo_root"
pnpm --dir packages/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "clears pending pool selection when crabbox resolution fails"

echo "PASS: failed crabbox resolution clears pending SSH pool selection"
