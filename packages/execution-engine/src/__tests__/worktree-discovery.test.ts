import { describe, it, expect } from 'vitest';
import {
  parseGitWorktreePorcelain,
  findManagedWorktreeForBranch,
  abbrevRefMatchesBranch,
} from '../worktree-discovery.js';

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
