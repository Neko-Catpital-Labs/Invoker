import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn((_file, args, options, callback) => {
    if (args?.[0] === '--version') {
      callback?.(null, '10.31.0\n', '');
      return {} as never;
    }
    if (args?.[0] === 'install' && options?.cwd && existsSync(options.cwd)) {
      mkdirSync(join(options.cwd, 'node_modules', '.pnpm'), { recursive: true });
      writeFileSync(join(options.cwd, 'node_modules', '.modules.yaml'), 'layoutVersion: 5\n', 'utf8');
    }
    callback?.(null, '', '');
    return {} as never;
  }),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: childProcessMocks.execFile,
  };
});

import {
  ensurePlanningWorktreeReady,
  provisionPlanningWorktree,
  releasePlanningWorktree,
  resolvePlanningWorktreeBranch,
  type PlanningRepoPool,
} from '../planning-chat-worktree.js';

function createFakePool(overrides: Partial<Record<keyof PlanningRepoPool, unknown>> = {}) {
  const release = vi.fn().mockResolvedValue(undefined);
  const softRelease = vi.fn();
  const ensureCloneThroughRepoQueue = vi.fn().mockResolvedValue('/clone/path');
  const resolveBaseCommit = vi.fn().mockResolvedValue('resolved-head-sha');
  const acquireWorktree = vi.fn().mockResolvedValue({
    clonePath: '/clone/path',
    worktreePath: '/worktrees/acquired',
    branch: 'invoker/planning/session-1',
    release,
    softRelease,
  });
  const externalWorktreePath = vi.fn().mockReturnValue('/worktrees/deterministic');
  return {
    pool: {
      ensureCloneThroughRepoQueue,
      resolveBaseCommit,
      acquireWorktree,
      externalWorktreePath,
      ...overrides,
    } as unknown as PlanningRepoPool,
    spies: { ensureCloneThroughRepoQueue, resolveBaseCommit, acquireWorktree, externalWorktreePath, release, softRelease },
  };
}

function installCalls(): unknown[][] {
  return childProcessMocks.execFile.mock.calls.filter((call) => {
    const args = call[1] as string[] | undefined;
    return args?.[0] === 'install';
  });
}

function createDependencyWorktree(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');
  writeFileSync(join(path, 'package.json'), JSON.stringify({
    name,
    packageManager: 'pnpm@10.31.0',
  }), 'utf8');
  return path;
}

describe('resolvePlanningWorktreeBranch', () => {
  it('derives an invoker/-prefixed branch name from the session id', () => {
    expect(resolvePlanningWorktreeBranch('session-1')).toBe('invoker/planning/session-1');
  });
});

describe('provisionPlanningWorktree', () => {
  beforeEach(() => {
    childProcessMocks.execFile.mockClear();
  });

  it('calls pool methods in order and returns the acquired worktree, calling softRelease', async () => {
    const { pool, spies } = createFakePool();
    const calls: string[] = [];
    spies.ensureCloneThroughRepoQueue.mockImplementation(async (repoUrl: string) => {
      calls.push('ensureCloneThroughRepoQueue');
      return `/clone/${repoUrl}`;
    });
    spies.resolveBaseCommit.mockImplementation(async () => {
      calls.push('resolveBaseCommit');
      return 'resolved-head-sha';
    });
    spies.acquireWorktree.mockImplementation(async () => {
      calls.push('acquireWorktree');
      return {
        clonePath: '/clone/path',
        worktreePath: '/nonexistent/planning-worktree-path-for-test',
        branch: 'invoker/planning/session-1',
        release: spies.release,
        softRelease: spies.softRelease,
      };
    });

    const result = await provisionPlanningWorktree(pool, {
      repoUrl: 'https://example.com/repo.git',
      baseBranch: 'main',
      sessionId: 'session-1',
    });

    expect(calls).toEqual(['ensureCloneThroughRepoQueue', 'resolveBaseCommit', 'acquireWorktree']);
    expect(spies.acquireWorktree).toHaveBeenCalledWith(
      'https://example.com/repo.git',
      'invoker/planning/session-1',
      'resolved-head-sha',
      'session-1',
    );
    expect(result).toEqual({
      worktreePath: '/nonexistent/planning-worktree-path-for-test',
      baseCommit: 'resolved-head-sha',
      branch: 'invoker/planning/session-1',
    });
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      'pnpm',
      ['install', '--frozen-lockfile', '--ignore-scripts'],
      expect.objectContaining({
        cwd: '/nonexistent/planning-worktree-path-for-test',
        timeout: 120_000,
      }),
      expect.any(Function),
    );
    expect(spies.softRelease).toHaveBeenCalledTimes(1);
  });

  it('reuses a validated dependency snapshot for a second planning worktree with the same lockfile inputs', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'planning-worktree-deps-'));
    try {
      const firstWorktree = createDependencyWorktree(tmpDir, 'first');
      const secondWorktree = createDependencyWorktree(tmpDir, 'second');
      const cacheRoot = join(tmpDir, 'dependency-cache');
      const { pool, spies } = createFakePool();
      spies.acquireWorktree
        .mockResolvedValueOnce({
          clonePath: '/clone/path',
          worktreePath: firstWorktree,
          branch: 'invoker/planning/session-1',
          release: spies.release,
          softRelease: spies.softRelease,
        })
        .mockResolvedValueOnce({
          clonePath: '/clone/path',
          worktreePath: secondWorktree,
          branch: 'invoker/planning/session-2',
          release: spies.release,
          softRelease: spies.softRelease,
        });

      await provisionPlanningWorktree(pool, {
        repoUrl: 'https://example.com/repo.git',
        baseBranch: 'main',
        sessionId: 'session-1',
      }, { cacheRoot });
      await provisionPlanningWorktree(pool, {
        repoUrl: 'https://example.com/repo.git',
        baseBranch: 'main',
        sessionId: 'session-2',
      }, { cacheRoot });

      expect(installCalls()).toHaveLength(1);
      expect(readFileSync(join(secondWorktree, 'node_modules', '.modules.yaml'), 'utf8')).toContain('layoutVersion');
      expect(spies.softRelease).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('ensurePlanningWorktreeReady', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'planning-worktree-ready-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns recreated: false without acquiring when the worktree already exists on disk', async () => {
    const { pool, spies } = createFakePool();
    spies.externalWorktreePath.mockReturnValue(tmpDir);
    expect(existsSync(tmpDir)).toBe(true);

    const result = await ensurePlanningWorktreeReady(pool, {
      repoUrl: 'https://example.com/repo.git',
      baseCommit: 'stored-base-commit',
      sessionId: 'session-1',
    });

    expect(result).toEqual({ worktreePath: tmpDir, recreated: false });
    expect(spies.acquireWorktree).not.toHaveBeenCalled();
    expect(spies.resolveBaseCommit).not.toHaveBeenCalled();
    expect(spies.ensureCloneThroughRepoQueue).not.toHaveBeenCalled();
  });

  it('recreates using the stored baseCommit (never re-resolving HEAD) when the path is missing', async () => {
    const missingPath = join(tmpDir, 'missing', 'worktree');
    const { pool, spies } = createFakePool();
    spies.externalWorktreePath.mockReturnValue(missingPath);
    spies.acquireWorktree.mockResolvedValue({
      clonePath: '/clone/path',
      worktreePath: missingPath,
      branch: 'invoker/planning/session-1',
      release: spies.release,
      softRelease: spies.softRelease,
    });
    expect(existsSync(missingPath)).toBe(false);

    const result = await ensurePlanningWorktreeReady(pool, {
      repoUrl: 'https://example.com/repo.git',
      baseCommit: 'stored-base-commit',
      sessionId: 'session-1',
    });

    expect(spies.resolveBaseCommit).not.toHaveBeenCalled();
    expect(spies.ensureCloneThroughRepoQueue).toHaveBeenCalledWith('https://example.com/repo.git');
    expect(spies.acquireWorktree).toHaveBeenCalledWith(
      'https://example.com/repo.git',
      'invoker/planning/session-1',
      'stored-base-commit',
      'session-1',
    );
    expect(result).toEqual({ worktreePath: missingPath, recreated: true });
    expect(spies.softRelease).toHaveBeenCalledTimes(1);
  });
});

describe('releasePlanningWorktree', () => {
  it('re-acquires the deterministic worktree then calls release()', async () => {
    const { pool, spies } = createFakePool();

    await releasePlanningWorktree(pool, {
      repoUrl: 'https://example.com/repo.git',
      baseCommit: 'stored-base-commit',
      sessionId: 'session-1',
    });

    expect(spies.acquireWorktree).toHaveBeenCalledWith(
      'https://example.com/repo.git',
      'invoker/planning/session-1',
      'stored-base-commit',
      'session-1',
    );
    expect(spies.release).toHaveBeenCalledTimes(1);
  });
});
