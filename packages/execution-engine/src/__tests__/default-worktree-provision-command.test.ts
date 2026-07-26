import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKTREE_PROVISION_COMMAND } from '../default-worktree-provision-command.js';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'invoker-worktree-provision-'));
  tmpDirs.push(dir);
  return dir;
}

function runProvision(cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('/bin/bash', ['-c', DEFAULT_WORKTREE_PROVISION_COMMAND], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function writeFakePnpm(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const pnpmPath = join(binDir, 'pnpm');
  writeFileSync(
    pnpmPath,
    [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$@" > "$PWD/pnpm-args.txt"',
      'mkdir -p "$PWD/node_modules"',
      '',
    ].join('\n'),
  );
  chmodSync(pnpmPath, 0o755);
}

describe('DEFAULT_WORKTREE_PROVISION_COMMAND', () => {
  afterEach(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it('installs pnpm dependencies when a lockfile exists and node_modules is missing', () => {
    const workspace = makeTmpDir();
    const binDir = join(workspace, 'bin');
    writeFakePnpm(binDir);
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');

    const result = runProvision(workspace, {
      PATH: `${binDir}:/usr/bin:/bin`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Installing pnpm dependencies');
    expect(readFileSync(join(workspace, 'pnpm-args.txt'), 'utf8')).toBe(
      'install\n--frozen-lockfile\n',
    );
    expect(existsSync(join(workspace, 'node_modules'))).toBe(true);
  });

  it('skips installation when explicitly disabled', () => {
    const workspace = makeTmpDir();
    const binDir = join(workspace, 'bin');
    writeFakePnpm(binDir);
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');

    const result = runProvision(workspace, {
      INVOKER_SKIP_MANAGED_PNPM_INSTALL: '1',
      PATH: `${binDir}:/usr/bin:/bin`,
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(workspace, 'pnpm-args.txt'))).toBe(false);
    expect(existsSync(join(workspace, 'node_modules'))).toBe(false);
  });

  it('skips installation when node_modules already exists', () => {
    const workspace = makeTmpDir();
    const binDir = join(workspace, 'bin');
    writeFakePnpm(binDir);
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    mkdirSync(join(workspace, 'node_modules'));

    const result = runProvision(workspace, {
      PATH: `${binDir}:/usr/bin:/bin`,
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(workspace, 'pnpm-args.txt'))).toBe(false);
  });
});
