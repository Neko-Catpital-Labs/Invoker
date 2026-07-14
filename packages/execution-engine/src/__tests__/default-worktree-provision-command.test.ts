import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_WORKTREE_PROVISION_COMMAND } from '../default-worktree-provision-command.js';

const tempDirs: string[] = [];

function createWorkspace(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}


function runProvision(cwd: string, env: NodeJS.ProcessEnv = {}) {
  const exports = Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `export ${key}=${shellQuote(value)};`)
    .join(' ');
  return spawnSync('/bin/bash', ['-lc', `${exports} set -euo pipefail; ${DEFAULT_WORKTREE_PROVISION_COMMAND}; echo __AFTER__`], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('DEFAULT_WORKTREE_PROVISION_COMMAND', () => {
  it('skips provisioning for Flutter-style repos and continues execution', () => {
    const dir = createWorkspace('default-provision-flutter-');
    writeFileSync(join(dir, 'pubspec.yaml'), 'name: flutter_fixture\n');

    const result = runProvision(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[provision] No pnpm lock/workspace file found; skipping default pnpm provision');
    expect(result.stdout).toContain('__AFTER__');
  });

  it('skips provisioning for package.json-only repos and continues execution', () => {
    const dir = createWorkspace('default-provision-package-json-');
    writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');

    const result = runProvision(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[provision] No pnpm lock/workspace file found; skipping default pnpm provision');
    expect(result.stdout).toContain('__AFTER__');
  });

  it('runs pnpm install exactly once when pnpm markers exist', () => {
    const dir = createWorkspace('default-provision-pnpm-');
    const binDir = join(dir, 'bin');
    const pnpmLogPath = join(dir, 'pnpm.log');
    const fakePnpmPath = join(binDir, 'pnpm');

    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    writeFileSync(
      fakePnpmPath,
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$INVOKER_TEST_PNPM_LOG"\n',
    );
    chmodSync(fakePnpmPath, 0o755);

    const result = runProvision(dir, {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      INVOKER_TEST_PNPM_LOG: pnpmLogPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('__AFTER__');
    expect(readFileSync(pnpmLogPath, 'utf8').trim().split('\n')).toEqual(['install --frozen-lockfile']);
  });
});
