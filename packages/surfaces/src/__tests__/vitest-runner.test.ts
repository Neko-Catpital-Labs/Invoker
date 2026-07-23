import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('vitest runner', () => {
  it('installs filtered workspace dependencies when the Vitest binary is missing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'surfaces-vitest-runner-'));
    const binDir = join(tempDir, 'bin');
    const callsPath = join(tempDir, 'pnpm.calls');
    const readyPath = join(tempDir, 'pnpm.ready');
    const runnerPath = fileURLToPath(new URL('../../scripts/vitest-run.cjs', import.meta.url));

    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'pnpm'),
        `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$PNPM_CALLS"
case "$*" in
  "exec vitest --version")
    if [ -f "$PNPM_READY" ]; then
      exit 0
    fi
    exit 1
    ;;
  "--filter @invoker/surfaces... install --frozen-lockfile --ignore-scripts --prod=false")
    touch "$PNPM_READY"
    exit 0
    ;;
  "exec vitest run sample.test.ts")
    exit 0
    ;;
esac
echo "unexpected pnpm args: $*" >&2
exit 42
`,
      );
      chmodSync(join(binDir, 'pnpm'), 0o755);

      const result = spawnSync(process.execPath, [runnerPath, '--', 'sample.test.ts'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          PNPM_CALLS: callsPath,
          PNPM_READY: readyPath,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'Vitest binary is unavailable; installing filtered workspace dependencies for @invoker/surfaces',
      );
      expect(readFileSync(callsPath, 'utf8').trim().split('\n')).toEqual([
        'exec vitest --version',
        '--filter @invoker/surfaces... install --frozen-lockfile --ignore-scripts --prod=false',
        'exec vitest --version',
        'exec vitest run sample.test.ts',
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
