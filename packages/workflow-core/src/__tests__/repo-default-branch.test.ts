import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as repoDefaultBranch from '../repo-default-branch.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Invoker Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Invoker Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

describe('repo-default-branch', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a bare repo whose path starts with a dash', () => {
    const root = mkdtempSync(join(tmpdir(), 'invoker-default-branch-'));
    tempDirs.push(root);
    const remoteRepo = join(root, '-origin.git');
    const worktree = join(root, 'worktree');

    git(root, ['init', '--bare', '--initial-branch=main', remoteRepo]);
    git(root, ['init', '--initial-branch=main', worktree]);
    writeFileSync(join(worktree, 'README.md'), 'test\n');
    git(worktree, ['add', 'README.md']);
    git(worktree, ['commit', '-m', 'init']);
    git(worktree, ['remote', 'add', 'origin', remoteRepo]);
    git(worktree, ['push', 'origin', 'main']);

    expect(repoDefaultBranch.detectDefaultBranchRemote(remoteRepo)).toBe('main');
  });

  it('redacts credentials when default-branch lookup fails', () => {
    vi.spyOn(repoDefaultBranch, 'detectDefaultBranchRemote').mockReturnValue(undefined);

    expect(() => repoDefaultBranch.requireDefaultBranchRemote('https://user:secret@example.invalid/repo.git')).toThrow(
      'Unable to resolve default branch for repo. Make the remote HEAD readable.',
    );
  });
});
