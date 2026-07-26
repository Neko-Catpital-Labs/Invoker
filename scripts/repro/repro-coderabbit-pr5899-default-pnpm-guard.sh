#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

cd "$repo_root"

pnpm --dir packages/execution-engine exec vitest run \
  src/__tests__/ssh-executor.test.ts \
  -t "managed mode preserves the missing-pnpm sentinel for the default provision command"

echo "PASS: default managed-workspace provisioning preserves the missing-pnpm sentinel"
