import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: childProcessMocks.execFile,
  };
});

import { preparePlanningWorktreeDependencies } from '../planning-chat-dependency-cache.js';

function createWorktree(root: string, name: string, options: { lockfile?: string; packageManager?: string } = {}): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'pnpm-lock.yaml'), options.lockfile ?? 'lockfileVersion: 9.0\n', 'utf8');
  writeFileSync(join(path, 'package.json'), JSON.stringify({
    name,
    packageManager: options.packageManager ?? 'pnpm@10.31.0',
  }), 'utf8');
  return path;
}

function installCalls(): unknown[][] {
  return childProcessMocks.execFile.mock.calls.filter((call) => {
    const args = call[1] as string[] | undefined;
    return args?.[0] === 'install';
  });
}

function mockSuccessfulPnpmInstall(delayMs = 0): void {
  childProcessMocks.execFile.mockImplementation((_file, args, options, callback) => {
    if (args[0] === '--version') {
      callback?.(null, '10.31.0\n', '');
      return {} as never;
    }
    setTimeout(() => {
      const cwd = options.cwd as string;
      mkdirSync(join(cwd, 'node_modules', '.pnpm'), { recursive: true });
      writeFileSync(join(cwd, 'node_modules', '.modules.yaml'), 'layoutVersion: 5\n', 'utf8');
      writeFileSync(join(cwd, 'node_modules', 'installed-from.txt'), cwd, 'utf8');
      callback?.(null, '', '');
    }, delayMs);
    return {} as never;
  });
}

describe('planning-chat dependency cache', () => {
  let root: string;
  let cacheRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'planning-deps-cache-test-'));
    cacheRoot = join(root, 'cache');
    childProcessMocks.execFile.mockReset();
    mockSuccessfulPnpmInstall();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('installs on a cold miss, then restores an identical lockfile without sharing a writable node_modules tree', async () => {
    const first = createWorktree(root, 'first');
    const cold = await preparePlanningWorktreeDependencies(first, { cacheRoot });

    expect(cold.status).toBe('miss-installed');
    expect(installCalls()).toHaveLength(1);
    expect(existsSync(join(first, 'node_modules', '.modules.yaml'))).toBe(true);

    const second = createWorktree(root, 'second');
    const warm = await preparePlanningWorktreeDependencies(second, { cacheRoot });

    expect(warm.status).toBe('hit');
    expect(warm.cacheKey).toBe(cold.cacheKey);
    expect(installCalls()).toHaveLength(1);
    expect(readFileSync(join(second, 'node_modules', '.modules.yaml'), 'utf8')).toContain('layoutVersion');
    expect(lstatSync(join(second, 'node_modules')).isSymbolicLink()).toBe(false);

    writeFileSync(join(second, 'node_modules', 'private.txt'), 'second-only', 'utf8');
    expect(existsSync(join(first, 'node_modules', 'private.txt'))).toBe(false);
  });

  it('misses when compatibility inputs change', async () => {
    await preparePlanningWorktreeDependencies(createWorktree(root, 'base'), { cacheRoot });

    const changedLockfile = createWorktree(root, 'changed-lockfile', {
      lockfile: 'lockfileVersion: 9.0\npackages:\n  left-pad@1.3.0: {}\n',
    });
    const changedPackageManager = createWorktree(root, 'changed-package-manager', {
      packageManager: 'pnpm@10.32.0',
    });

    expect((await preparePlanningWorktreeDependencies(changedLockfile, { cacheRoot })).status).toBe('miss-installed');
    expect((await preparePlanningWorktreeDependencies(changedPackageManager, { cacheRoot })).status).toBe('miss-installed');
    expect(installCalls()).toHaveLength(3);
  });

  it('converges concurrent creators on one published snapshot', async () => {
    mockSuccessfulPnpmInstall(20);
    const first = createWorktree(root, 'concurrent-a');
    const second = createWorktree(root, 'concurrent-b');

    const [a, b] = await Promise.all([
      preparePlanningWorktreeDependencies(first, { cacheRoot }),
      preparePlanningWorktreeDependencies(second, { cacheRoot }),
    ]);

    expect([a.status, b.status].sort()).toEqual(['hit', 'miss-installed']);
    expect(a.cacheKey).toBe(b.cacheKey);
    expect(installCalls()).toHaveLength(1);
    expect(existsSync(join(first, 'node_modules', '.modules.yaml'))).toBe(true);
    expect(existsSync(join(second, 'node_modules', '.modules.yaml'))).toBe(true);
  });

  it('treats corrupt cache entries as misses and republishes them', async () => {
    const first = createWorktree(root, 'corrupt-source');
    const cold = await preparePlanningWorktreeDependencies(first, { cacheRoot });
    expect(cold.cacheKey).toBeTruthy();

    const entry = join(cacheRoot, 'entries', cold.cacheKey!);
    writeFileSync(join(entry, 'manifest.json'), '{"schemaVersion":1,"key":"wrong"}\n', 'utf8');

    const second = createWorktree(root, 'corrupt-consumer');
    const result = await preparePlanningWorktreeDependencies(second, { cacheRoot });

    expect(result.status).toBe('miss-installed');
    expect(installCalls()).toHaveLength(2);
    expect(readFileSync(join(entry, 'manifest.json'), 'utf8')).toContain(cold.cacheKey!);
  });

  it('leaves the cache incomplete and reports the existing soft-failure install path when install fails', async () => {
    childProcessMocks.execFile.mockImplementation((_file, args, _options, callback) => {
      if (args[0] === '--version') {
        callback?.(null, '10.31.0\n', '');
        return {} as never;
      }
      callback?.(new Error('install failed'), '', 'broken');
      return {} as never;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const worktree = createWorktree(root, 'failed-install');

    const result = await preparePlanningWorktreeDependencies(worktree, { cacheRoot });

    expect(result.status).toBe('miss-install-failed');
    expect(installCalls()).toHaveLength(1);
    expect(existsSync(join(cacheRoot, 'entries', result.cacheKey ?? '', 'manifest.json'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pnpm install --frozen-lockfile --ignore-scripts failed'));
    warn.mockRestore();
  });
});
