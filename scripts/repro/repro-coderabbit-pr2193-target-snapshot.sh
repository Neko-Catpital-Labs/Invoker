#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

cd "$repo_root"
pnpm --dir packages/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "builds from the selected crabbox target snapshot after async resolution"

echo "PASS: crabbox executor construction uses the selected target snapshot after async resolution"
