#!/usr/bin/env bash
# Repro: signal-terminated Crabbox child processes must not resolve as success.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_FILE="$REPO_ROOT/packages/execution-engine/src/__tests__/repro-coderabbit-pr2184-null-exit-code.test.ts"
trap 'rm -f "$TEST_FILE"' EXIT

cat >"$TEST_FILE" <<'TS'
import { describe, expect, it } from 'vitest';
import { spawnCrabboxCommand } from '../crabbox-target-resolver.js';

describe('CodeRabbit PR 2184 repro: null exit code', () => {
  it('rejects when the spawned Crabbox process is terminated by a signal', async () => {
    await expect(
      spawnCrabboxCommand(process.execPath, [
        '-e',
        'process.kill(process.pid, "SIGTERM")',
      ]),
    ).rejects.toThrow(/signal|terminated/i);
  });
});
TS

cd "$REPO_ROOT/packages/execution-engine"
echo "==> Running CodeRabbit PR 2184 null exit-code repro"
if pnpm exec vitest run src/__tests__/repro-coderabbit-pr2184-null-exit-code.test.ts; then
  echo "PASS: signal-terminated child process is treated as failure"
else
  status=$?
  echo "FAIL: signal-terminated child process was treated as success"
  exit "$status"
fi
