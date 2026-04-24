import { describe, it, expect } from 'vitest';
import {
  parseGitWorktreePorcelain,
  findManagedWorktreeForBranch,
  findManagedWorktreeByActionId,
  abbrevRefMatchesBranch,
  parseExperimentBranch,
} from '../worktree-discovery.js';
import { buildExperimentBranchName, formatLifecycleTag } from '../branch-utils.js';

describe('parseGitWorktreePorcelain', () => {
  it('parses main + linked worktree with branch', () => {
    const sample = `worktree /repo/main
HEAD abcdef123
branch refs/heads/main

worktree /repo/.worktrees/feature
HEAD deadbeef
branch refs/heads/experiment/task-abc
`;
    const entries = parseGitWorktreePorcelain(sample);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ path: '/repo/main', branch: 'main' });
    expect(entries[1]).toEqual({ path: '/repo/.worktrees/feature', branch: 'experiment/task-abc' });
  });

  it('handles detached HEAD (no branch line with refs/heads)', () => {
    const sample = `worktree /repo/wt
HEAD abc123
detached
`;
    const entries = parseGitWorktreePorcelain(sample);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ path: '/repo/wt' });
  });
});

describe('findManagedWorktreeForBranch', () => {
  const porcelain = `worktree /home/u/project
HEAD a
branch refs/heads/main

worktree /home/u/.invoker/wt/h/experiment-merge
HEAD b
branch refs/heads/experiment/__merge__wf-1-abcdef
`;

  it('returns path when branch matches and path is under prefix', () => {
    const p = findManagedWorktreeForBranch(
      porcelain,
      'experiment/__merge__wf-1-abcdef',
      ['/home/u/.invoker/wt/h'],
    );
    expect(p).toBe('/home/u/.invoker/wt/h/experiment-merge');
  });

  it('returns undefined when branch is outside managed prefixes', () => {
    const p = findManagedWorktreeForBranch(porcelain, 'main', ['/home/u/.invoker/wt/h']);
    expect(p).toBeUndefined();
  });

  it('returns undefined when branch name does not match', () => {
    const p = findManagedWorktreeForBranch(porcelain, 'other/branch', ['/home/u/.invoker/wt/h']);
    expect(p).toBeUndefined();
  });
});

describe('findManagedWorktreeByActionId', () => {
  const porcelain = `worktree /home/u/project
HEAD a
branch refs/heads/main

worktree /home/u/.invoker/wt/h/experiment-task1-aabb1122
HEAD b
branch refs/heads/experiment/task1-aabb1122

worktree /home/u/.invoker/wt/h/experiment-task2-ccdd3344
HEAD c
branch refs/heads/experiment/task2-ccdd3344
`;

  it('matches worktree with same actionId but different hash suffix', () => {
    // Looking for actionId "task1" — should match the branch experiment/task1-aabb1122
    const result = findManagedWorktreeByActionId(
      porcelain,
      'task1',
      ['/home/u/.invoker/wt/h'],
    );
    expect(result).toEqual({
      path: '/home/u/.invoker/wt/h/experiment-task1-aabb1122',
      branch: 'experiment/task1-aabb1122',
    });
  });

  it('returns undefined when actionId prefix does not match', () => {
    const result = findManagedWorktreeByActionId(
      porcelain,
      'nonexistent',
      ['/home/u/.invoker/wt/h'],
    );
    expect(result).toBeUndefined();
  });

  it('only matches managed paths (ignores bare-repo worktree)', () => {
    // The "main" branch worktree is at /home/u/project, not under managed prefix
    const result = findManagedWorktreeByActionId(
      porcelain,
      'task1',
      ['/other/prefix'],
    );
    expect(result).toBeUndefined();
  });

  it('does not match branches without experiment/ prefix', () => {
    const porcelainNoExp = `worktree /home/u/.invoker/wt/h/task1-aabb1122
HEAD b
branch refs/heads/task1-aabb1122
`;
    const result = findManagedWorktreeByActionId(
      porcelainNoExp,
      'task1',
      ['/home/u/.invoker/wt/h'],
    );
    expect(result).toBeUndefined();
  });
});

describe('parseExperimentBranch (round-trip with buildExperimentBranchName)', () => {
  it('round-trips canonical names', () => {
    const lifecycleTag = formatLifecycleTag({ wfGen: 3, taskGen: 5, attemptShort: 'abc12345' });
    const branch = buildExperimentBranchName('wf-1/build-app', lifecycleTag, 'deadbeef');
    expect(branch).toBe('experiment/wf-1/build-app/g3.t5.aabc12345-deadbeef');
    expect(parseExperimentBranch(branch)).toEqual({
      actionId: 'wf-1/build-app',
      lifecycleTag: 'g3.t5.aabc12345',
      contentHash: 'deadbeef',
    });
  });

  it('handles nested action ids with multiple slashes', () => {
    const branch = buildExperimentBranchName('wf-9/group/sub', 'g0.t0.az', 'cafebabe');
    expect(parseExperimentBranch(branch)).toEqual({
      actionId: 'wf-9/group/sub',
      lifecycleTag: 'g0.t0.az',
      contentHash: 'cafebabe',
    });
  });

  it('rejects legacy experiment/<actionId>-<sha8> format', () => {
    expect(parseExperimentBranch('experiment/wf-1/task-deadbeef')).toBeUndefined();
    expect(parseExperimentBranch('experiment/wf-1-deadbeef')).toBeUndefined();
  });

  it('rejects non-experiment branches', () => {
    expect(parseExperimentBranch('master')).toBeUndefined();
    expect(parseExperimentBranch('feature/foo')).toBeUndefined();
    expect(parseExperimentBranch('')).toBeUndefined();
  });

  it('rejects malformed lifecycle tag or hash', () => {
    expect(parseExperimentBranch('experiment/wf-1/task/g0.t0.a-NOTHEX1')).toBeUndefined();
    expect(parseExperimentBranch('experiment/wf-1/task/g0.t0-deadbeef')).toBeUndefined();
    expect(parseExperimentBranch('experiment/wf-1/task/garbage-deadbeef')).toBeUndefined();
  });
});

describe('abbrevRefMatchesBranch', () => {
  it('matches exact branch', () => {
    expect(abbrevRefMatchesBranch('experiment/foo', 'experiment/foo')).toBe(true);
  });
  it('rejects detached', () => {
    expect(abbrevRefMatchesBranch('HEAD', 'experiment/foo')).toBe(false);
  });
  it('rejects mismatch', () => {
    expect(abbrevRefMatchesBranch('main', 'experiment/foo')).toBe(false);
  });
});
