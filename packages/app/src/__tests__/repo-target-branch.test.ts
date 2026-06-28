import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { resolveRepoTargetBranch, saveRepoTargetBranch } from '../repo-target-branch.js';

let testDir: string;
let previousConfigPath: string | undefined;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Invoker Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Invoker Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function createBareRepo(defaultBranch: string): string {
  const bareRepo = join(testDir, 'repo.git');
  const worktree = join(testDir, 'worktree');
  git(['init', '--bare', bareRepo], testDir);
  git(['init', worktree], testDir);
  writeFileSync(join(worktree, 'README.md'), 'test\n');
  git(['add', 'README.md'], worktree);
  git(['commit', '-m', 'init'], worktree);
  git(['branch', '-M', defaultBranch], worktree);
  git(['remote', 'add', 'origin', bareRepo], worktree);
  git(['push', 'origin', defaultBranch], worktree);
  git(['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`], bareRepo);
  return bareRepo;
}

describe('repo target branch config', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'invoker-repo-target-'));
    previousConfigPath = process.env.INVOKER_REPO_CONFIG_PATH;
    process.env.INVOKER_REPO_CONFIG_PATH = join(testDir, 'config.json');
  });

  afterEach(() => {
    if (previousConfigPath === undefined) {
      delete process.env.INVOKER_REPO_CONFIG_PATH;
    } else {
      process.env.INVOKER_REPO_CONFIG_PATH = previousConfigPath;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('saves a repo target branch only when it exists on the remote', () => {
    const repoUrl = createBareRepo('main');

    expect(saveRepoTargetBranch(repoUrl, 'main')).toBe('main');
    expect(loadConfig().repoTargetBranches?.[repoUrl]).toBe('main');
    expect(() => saveRepoTargetBranch(repoUrl, 'missing')).toThrow(/does not exist/);
  });

  it('resolves configured repo branch before remote HEAD', () => {
    const repoUrl = createBareRepo('main');
    git(['--git-dir', repoUrl, 'branch', 'release', 'main'], testDir);
    saveRepoTargetBranch(repoUrl, 'release');

    expect(resolveRepoTargetBranch(repoUrl)).toBe('release');
  });

  it('resolves remote HEAD when no repo override exists', () => {
    const repoUrl = createBareRepo('main');

    expect(resolveRepoTargetBranch(repoUrl)).toBe('main');
  });
});
