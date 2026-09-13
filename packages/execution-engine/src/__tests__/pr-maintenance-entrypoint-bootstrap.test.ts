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
  { kind: 'pr-admin-bypass-land', scriptRelativePath: 'scripts/cron-pr-admin-bypass-land.sh' },
  { kind: 'pr-orphan-repair', scriptRelativePath: 'scripts/cron-pr-orphan-repair.sh' },
  { kind: 'pr-duplicate-close', scriptRelativePath: 'scripts/cron-pr-duplicate-close.sh' },
  { kind: 'pr-jailbreak-land', scriptRelativePath: 'scripts/cron-pr-jailbreak-land.sh' },
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

  it('duplicate-close entrypoint forwards repo, author, and dry-run controls to Python', () => {
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

    const result = spawnSync('bash', [resolve(repoRoot, 'scripts/cron-pr-duplicate-close.sh')], {
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
      'args=<scripts/pr_duplicate_close.py><--once><--repo><owner/repo><--author><octocat><--dry-run>',
      '',
    ].join('\n'));
  });
});

describe('cron_lock shared PR-maintenance lock', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'pr-maintenance-lock-wait-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('waits for a lock held by another operation and then takes it', () => {
    const lockPath = join(workDir, 'pr-crons.lock');
    const script = [
      'source scripts/cron-pr-lib.sh',
      'if command -v flock >/dev/null 2>&1; then',
      '  flock "$INVOKER_PR_CRON_LOCK" sleep 1 &',
      '  until ! flock -n "$INVOKER_PR_CRON_LOCK" true; do :; done',
      'else',
      '  mkdir "$INVOKER_PR_CRON_LOCK.d"',
      '  echo "$$" > "$INVOKER_PR_CRON_LOCK.d/pid"',
      '  ( sleep 1; rm -rf "$INVOKER_PR_CRON_LOCK.d" ) &',
      'fi',
      'cron_lock',
      'echo lock-acquired',
    ].join('\n');

    const result = spawnSync('bash', ['-c', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        INVOKER_PR_CRON_LOCK: lockPath,
        INVOKER_PR_CRON_LOCK_WAIT_SECS: '10',
      },
    });

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(output).not.toContain('another PR cron operation in progress');
    expect(result.stdout).toContain('lock-acquired');
    expect(result.status).toBe(0);
  });
});
