import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { parseWorktreeList, cleanupOrphanWorktrees } from '../worktree-cleanup.js';

const mockedExecSync = vi.mocked(execSync);

describe('parseWorktreeList', () => {
  it('parses porcelain output into entries', () => {
    const output = [
      'worktree /home/user/repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /home/user/.invoker/worktrees/exec-1',
      'HEAD def456',
      'branch refs/heads/experiment/my-task',
      '',
    ].join('\n');

    const entries = parseWorktreeList(output);
    expect(entries).toEqual([
      { path: '/home/user/repo', branch: 'main' },
      { path: '/home/user/.invoker/worktrees/exec-1', branch: 'experiment/my-task' },
    ]);
  });

  it('handles detached HEAD (no branch line)', () => {
    const output = [
      'worktree /home/user/.invoker/worktrees/exec-2',
      'HEAD abc123',
      'detached',
      '',
    ].join('\n');

    const entries = parseWorktreeList(output);
    expect(entries).toEqual([
      { path: '/home/user/.invoker/worktrees/exec-2' },
    ]);
  });

  it('returns empty array for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('cleanupOrphanWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const porcelainOutput = [
    'worktree /repo',
    'HEAD aaa',
    'branch refs/heads/main',
    '',
    'worktree /wt/exec-1',
    'HEAD bbb',
    'branch refs/heads/experiment/task-in-db',
    '',
    'worktree /wt/exec-2',
    'HEAD ccc',
    'branch refs/heads/experiment/orphan-task',
    '',
    'worktree /wt/exec-3',
    'HEAD ddd',
    'branch refs/heads/experiment/another-orphan',
    '',
  ].join('\n');

  it('removes worktrees not in the known task set', () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('worktree list')) {
        return porcelainOutput;
      }
      return '';
    });

    const knownIds = new Set(['task-in-db']);
    const result = cleanupOrphanWorktrees('/repo', knownIds);

    expect(result.removed).toEqual(['orphan-task', 'another-orphan']);
    expect(result.errors).toEqual([]);

    const calls = mockedExecSync.mock.calls.map((c) => c[0]);
    expect(calls).toContain('git worktree remove --force "/wt/exec-2"');
    expect(calls).toContain('git branch -D "experiment/orphan-task"');
    expect(calls).toContain('git worktree remove --force "/wt/exec-3"');
    expect(calls).toContain('git branch -D "experiment/another-orphan"');
    expect(calls).toContain('git worktree prune');
  });

  it('skips non-experiment branches', () => {
    const output = [
      'worktree /repo',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /wt/feat',
      'HEAD bbb',
      'branch refs/heads/feature/unrelated',
      '',
    ].join('\n');

    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('worktree list')) return output;
      return '';
    });

    const result = cleanupOrphanWorktrees('/repo', new Set());
    expect(result.removed).toEqual([]);
  });

  it('does not remove worktrees for tasks that exist in DB', () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('worktree list')) return porcelainOutput;
      return '';
    });

    const knownIds = new Set(['task-in-db', 'orphan-task', 'another-orphan']);
    const result = cleanupOrphanWorktrees('/repo', knownIds);

    expect(result.removed).toEqual([]);
  });

  it('reports errors when worktree removal fails', () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('worktree list')) return porcelainOutput;
      if (typeof cmd === 'string' && cmd.includes('worktree remove')) throw new Error('locked');
      return '';
    });

    const result = cleanupOrphanWorktrees('/repo', new Set(['task-in-db']));

    expect(result.removed).toEqual([]);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('orphan-task');
    expect(result.errors[1]).toContain('another-orphan');
  });

  it('handles failure to list worktrees', () => {
    mockedExecSync.mockImplementation(() => { throw new Error('not a git repo'); });

    const result = cleanupOrphanWorktrees('/repo', new Set());

    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual(['Failed to list worktrees']);
  });
});
