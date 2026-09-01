#!/bin/sh
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../../.." && pwd)
cd "$repo_root"

exec pnpm --filter @invoker/app test -- \
  src/__tests__/config.test.ts \
  -t 'materializes the built-in local worktree pool'
