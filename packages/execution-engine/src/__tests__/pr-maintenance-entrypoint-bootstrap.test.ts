import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveRepoRoot } from '@invoker/contracts';

const repoRoot = resolveRepoRoot(process.cwd());

// Every registered PR-maintenance cron entrypoint. Add a new worker's script
// here so this guard proves the script can source its shared library.
const PR_MAINTENANCE_ENTRYPOINTS = [
  { kind: 'coderabbit-address', scriptRelativePath: 'scripts/cron-coderabbit-address.sh' },
  { kind: 'pr-conflict-rebase', scriptRelativePath: 'scripts/cron-pr-conflict-rebase.sh' },
  { kind: 'pr-ci-failure-scan', scriptRelativePath: 'packages/execution-engine/scripts/cron-pr-ci-failure.sh' },
  { kind: 'pr-admin-bypass-land', scriptRelativePath: 'scripts/cron-pr-admin-bypass-land.sh' },
] as const;

describe('PR maintenance entrypoints bootstrap', () => {
  let stubBin: string;
  let lockPath: string;

  beforeEach(() => {
    stubBin = mkdtempSync(join(tmpdir(), 'pr-maintenance-stub-bin-'));
    // Force every entrypoint down its lock-held early-exit: a `flock` stub that
    // always reports the lock busy makes cron_lock return exit 0 right after the
    // script sources cron-pr-lib.sh — so the run only proves the source resolved,
    // never touching gh/git/the network.
    const flockStub = join(stubBin, 'flock');
    writeFileSync(flockStub, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
    chmodSync(flockStub, 0o755);
    lockPath = join(stubBin, 'pr-crons.lock');
  });

  afterEach(() => {
    rmSync(stubBin, { recursive: true, force: true });
  });

  it('registers at least one entrypoint to guard', () => {
    expect(PR_MAINTENANCE_ENTRYPOINTS.length).toBeGreaterThan(0);
  });

  for (const entrypoint of PR_MAINTENANCE_ENTRYPOINTS) {
    it(`${entrypoint.kind} script exists and can source its shared library`, () => {
      const scriptPath = resolve(repoRoot, entrypoint.scriptRelativePath);
      expect(existsSync(scriptPath)).toBe(true);

      const result = spawnSync('bash', [scriptPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          PATH: `${stubBin}:${process.env.PATH ?? ''}`,
          INVOKER_PR_CRON_LOCK: lockPath,
        },
      });

      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(output).not.toContain('No such file or directory');
      expect(result.status).toBe(0);
    });
  }

  it('admin-bypass entrypoint forwards repo, author, and dry-run controls to Python', () => {
    writeFileSync(join(stubBin, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const capturePath = join(stubBin, 'python-args.txt');
    const pythonStub = join(stubBin, 'python3');
    writeFileSync(
      pythonStub,
      [
        '#!/usr/bin/env bash',
        '{',
        '  printf "cwd=%s\\n" "$PWD"',
        '  printf "args="',
        '  printf "<%s>" "$@"',
        '  printf "\\n"',
        '} > "$PYTHON_CAPTURE"',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const result = spawnSync('bash', [resolve(repoRoot, 'scripts/cron-pr-admin-bypass-land.sh')], {
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        INVOKER_GITHUB_TARGET_REPO: 'owner/repo',
        INVOKER_PR_CRON_AUTHOR: 'octocat',
        INVOKER_PR_CRON_DRY_RUN: '1',
        INVOKER_PR_CRON_LOCK: lockPath,
        PYTHON_CAPTURE: capturePath,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(capturePath, 'utf8')).toBe([
      `cwd=${repoRoot}`,
      'args=<scripts/mergify_admin_requeue.py><--once><--repo><owner/repo><--author><octocat><--dry-run>',
      '',
    ].join('\n'));
  });
});
