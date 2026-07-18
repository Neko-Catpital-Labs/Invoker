#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

cd "$repo_root"
pnpm --dir packages/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "pins SSH approved-fix publish to the recorded pool member in mixed pools"

echo "PASS: approved-fix publish honors the recorded SSH pool member instead of reselecting a mixed-pool executor"
