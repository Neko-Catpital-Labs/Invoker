#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_root"

type_block="$(sed -n '/export type RemoteTargetDisplay = {/,/};/p' packages/execution-engine/src/task-runner-pool.ts)"

if ! printf '%s\n' "$type_block" | grep -q 'provisionCommand?: string;'; then
  echo "FAIL: RemoteTargetDisplay is missing provisionCommand, so selectExecutor cannot read target.provisionCommand safely." >&2
  exit 1
fi

echo "PASS: RemoteTargetDisplay includes provisionCommand for target.provisionCommand access"
