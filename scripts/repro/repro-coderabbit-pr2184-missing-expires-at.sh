#!/usr/bin/env bash
# Repro: Crabbox lease metadata must not persist a blank expiresAt timestamp.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_FILE="$REPO_ROOT/packages/execution-engine/src/__tests__/repro-coderabbit-pr2184-missing-expires-at.test.ts"
trap 'rm -f "$TEST_FILE"' EXIT

cat >"$TEST_FILE" <<'TS'
import { describe, expect, it } from 'vitest';
import {
  CrabboxTargetResolver,
  type CrabboxCommandResult,
} from '../crabbox-target-resolver.js';

const ok = (stdout: string): CrabboxCommandResult => ({ stdout, stderr: '', exitCode: 0 });

describe('CodeRabbit PR 2184 repro: missing expiresAt', () => {
  it('rejects status JSON missing expiresAt instead of returning blank metadata', async () => {
    const status = JSON.stringify({
      id: 'lease-123',
      slug: 'happy-crab',
      sshHost: '10.0.0.5',
      sshUser: 'invoker',
      sshKey: '/home/me/.ssh/crabbox',
    });
    const results = [ok('lease-123'), ok(status)];
    const resolver = new CrabboxTargetResolver(async () => {
      const result = results.shift();
      if (!result) throw new Error('unexpected Crabbox invocation');
      return result;
    });

    await expect(
      resolver.resolve({
        id: 'crab1',
        crabboxCommand: 'crabbox',
        provider: 'fly',
        class: 'performance-4x',
        ttl: '30m',
        idleTimeout: '10m',
        network: 'invoker-net',
        target: 'us-east',
        stopAfter: 'completed',
        keepOnFailure: true,
      }),
    ).rejects.toThrow(/expiresAt/);
  });
});
TS

cd "$REPO_ROOT/packages/execution-engine"
echo "==> Running CodeRabbit PR 2184 missing expiresAt repro"
if pnpm exec vitest run src/__tests__/repro-coderabbit-pr2184-missing-expires-at.test.ts; then
  echo "PASS: missing expiresAt is rejected before lease metadata is built"
else
  status=$?
  echo "FAIL: missing expiresAt produced invalid blank lease metadata"
  exit "$status"
fi
