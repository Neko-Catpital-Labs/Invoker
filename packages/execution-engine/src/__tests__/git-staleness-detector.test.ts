/**
 * Git staleness detector tests.
 *
 * Validates that checkStaleness correctly identifies when local refs are
 * behind, ahead, or in sync with remote refs, using real git repos.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { checkStaleness } from '../git-staleness-detector.js';

/**
 * Simple git execution wrapper for tests.
 */
async function execGit(args: string[], cwd: string): Promise<string> {
  return execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf8' });
}

/**
 * Create a temp git repo with initial commit.
 */
function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-staleness-'));
  execSync('git init -b master', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, 'initial.txt'), 'initial');
  execSync('git add -A && git commit -m "initial"', { cwd: dir });
  return dir;
}

/**
 * Create a bare remote repo and push local to it.
 * Returns the path to the bare repo.
 */
function createRemote(localRepo: string): string {
  const remote = mkdtempSync(join(tmpdir(), 'git-staleness-remote-'));
  execSync('git init --bare -b master', { cwd: remote });
  execSync(`git remote add origin ${remote}`, { cwd: localRepo });
  execSync('git push -u origin master', { cwd: localRepo });
  return remote;
}

/**
 * Get current HEAD commit SHA.
 */
function getCommitSHA(repo: string, ref = 'HEAD'): string {
  return execSync(`git rev-parse ${ref}`, { cwd: repo, encoding: 'utf8' }).trim();
}

describe('checkStaleness', () => {
  let localRepo: string;
  let remoteRepo: string;

  beforeEach(() => {
    localRepo = createTempRepo();
    remoteRepo = createRemote(localRepo);
  });

  afterEach(() => {
    rmSync(localRepo, { recursive: true, force: true });
    rmSync(remoteRepo, { recursive: true, force: true });
  });

  it('returns not stale when local and remote are at same commit', async () => {
    const result = await checkStaleness(
      localRepo,
      'master',
      'origin/master',
      execGit
    );

    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
    expect(result.localCommit).toBe(result.remoteCommit);
    expect(result.warning).toBeUndefined();
  });

  it('returns stale when local is behind remote by 1 commit', async () => {
    // Create a second clone that will push ahead
    const secondClone = mkdtempSync(join(tmpdir(), 'git-staleness-clone-'));
    execSync(`git clone ${remoteRepo} ${secondClone}`, { cwd: tmpdir() });
    execSync('git checkout -B master origin/master', { cwd: secondClone });
    execSync('git config user.email "test@test.com"', { cwd: secondClone });
    execSync('git config user.name "Test"', { cwd: secondClone });

    // Push a new commit from second clone
    writeFileSync(join(secondClone, 'new.txt'), 'new');
    execSync('git add -A && git commit -m "new commit"', { cwd: secondClone });
    execSync('git push', { cwd: secondClone });

    // Fetch in local repo so origin/master updates
    execSync('git fetch', { cwd: localRepo });

    const result = await checkStaleness(
      localRepo,
      'master',
      'origin/master',
      execGit
    );

    expect(result.isStale).toBe(true);
    expect(result.commitsBehind).toBe(1);
    expect(result.localCommit).not.toBe(result.remoteCommit);
    expect(result.warning).toBeUndefined();

    // Cleanup
    rmSync(secondClone, { recursive: true, force: true });
  });

  it('returns stale when local is behind remote by multiple commits', async () => {
    // Create a second clone that will push ahead
    const secondClone = mkdtempSync(join(tmpdir(), 'git-staleness-clone-'));
    execSync(`git clone ${remoteRepo} ${secondClone}`, { cwd: tmpdir() });
    execSync('git checkout -B master origin/master', { cwd: secondClone });
    execSync('git config user.email "test@test.com"', { cwd: secondClone });
    execSync('git config user.name "Test"', { cwd: secondClone });

    // Push 3 new commits from second clone
    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(secondClone, `file${i}.txt`), `content${i}`);
      execSync(`git add -A && git commit -m "commit ${i}"`, { cwd: secondClone });
    }
    execSync('git push', { cwd: secondClone });

    // Fetch in local repo so origin/master updates
    execSync('git fetch', { cwd: localRepo });

    const result = await checkStaleness(
      localRepo,
      'master',
      'origin/master',
      execGit
    );

    expect(result.isStale).toBe(true);
    expect(result.commitsBehind).toBe(3);
    expect(result.localCommit).not.toBe(result.remoteCommit);
    expect(result.warning).toBeUndefined();

    // Cleanup
    rmSync(secondClone, { recursive: true, force: true });
  });

  it('returns not stale when local is ahead of remote', async () => {
    // Add a local commit that hasn't been pushed
    writeFileSync(join(localRepo, 'local-only.txt'), 'local');
    execSync('git add -A && git commit -m "local ahead"', { cwd: localRepo });

    const result = await checkStaleness(
      localRepo,
      'master',
      'origin/master',
      execGit
    );

    // Local is ahead, not behind, so not stale
    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
    expect(result.localCommit).not.toBe(result.remoteCommit);
    expect(result.warning).toBeUndefined();
  });

  it('returns warning when local ref does not exist', async () => {
    const result = await checkStaleness(
      localRepo,
      'nonexistent-branch',
      'origin/master',
      execGit
    );

    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
    expect(result.localCommit).toBe('');
    expect(result.remoteCommit).toBeTruthy(); // Should have remote commit
    expect(result.warning).toContain('Failed to check staleness');
  });

  it('returns warning when remote ref does not exist', async () => {
    const result = await checkStaleness(
      localRepo,
      'master',
      'origin/nonexistent',
      execGit
    );

    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
    expect(result.localCommit).toBeTruthy(); // Should have local commit
    expect(result.remoteCommit).toBe('');
    expect(result.warning).toContain('Failed to check staleness');
  });

  it('returns warning when both refs do not exist', async () => {
    const result = await checkStaleness(
      localRepo,
      'nonexistent-local',
      'origin/nonexistent-remote',
      execGit
    );

    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
    expect(result.localCommit).toBe('');
    expect(result.remoteCommit).toBe('');
    expect(result.warning).toContain('Failed to check staleness');
  });

  it('works with HEAD as local ref', async () => {
    const result = await checkStaleness(
      localRepo,
      'HEAD',
      'origin/master',
      execGit
    );

    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
    expect(result.localCommit).toBe(getCommitSHA(localRepo));
    expect(result.warning).toBeUndefined();
  });

  it('handles diverged branches (local ahead and remote ahead)', async () => {
    // Create divergence: local has commit A, remote has commit B
    const secondClone = mkdtempSync(join(tmpdir(), 'git-staleness-clone-'));
    execSync(`git clone ${remoteRepo} ${secondClone}`, { cwd: tmpdir() });
    execSync('git checkout -B master origin/master', { cwd: secondClone });
    execSync('git config user.email "test@test.com"', { cwd: secondClone });
    execSync('git config user.name "Test"', { cwd: secondClone });

    // Remote side: push a commit
    writeFileSync(join(secondClone, 'remote.txt'), 'remote');
    execSync('git add -A && git commit -m "remote diverge"', { cwd: secondClone });
    execSync('git push', { cwd: secondClone });

    // Local side: add a different commit (before fetching)
    writeFileSync(join(localRepo, 'local.txt'), 'local');
    execSync('git add -A && git commit -m "local diverge"', { cwd: localRepo });

    // Now fetch so origin/master updates
    execSync('git fetch', { cwd: localRepo });

    const result = await checkStaleness(
      localRepo,
      'master',
      'origin/master',
      execGit
    );

    // Local is behind remote by 1 (remote has a commit local doesn't have)
    // Even though local is also ahead, staleness only checks if behind
    expect(result.isStale).toBe(true);
    expect(result.commitsBehind).toBe(1);
    expect(result.warning).toBeUndefined();

    // Cleanup
    rmSync(secondClone, { recursive: true, force: true });
  });
});
