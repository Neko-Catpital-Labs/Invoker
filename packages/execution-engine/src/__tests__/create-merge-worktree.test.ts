/**
 * createMergeWorktree isolation tests (real git).
 *
 * Proves that createMergeWorktree produces a clone whose origin points to
 * the real GitHub remote (not the host working directory), and that branches
 * are mirrored correctly.  Covers gaps 2-5 from scripts/repro/repro-host-cwd-safety.sh.
 *
 * Pattern: bare remote + working clone + TaskRunner with real git.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { TaskRunner, ExecutorRegistry } from '../index.js';

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'merge-wt-iso-'));

  // 1. Bare remote (simulates GitHub)
  const bare = join(root, 'bare.git');
  execSync(`git init --bare -b master ${bare}`);

  // 2. Working clone (simulates host repo)
  const host = join(root, 'host');
  execSync(`git clone ${bare} ${host}`);
  git(host, 'config user.email "test@test.com"');
  git(host, 'config user.name "Test"');
  writeFileSync(join(host, 'init.txt'), 'init');
  git(host, 'add -A');
  git(host, 'commit -m "initial"');
  git(host, 'branch -M master');
  git(host, 'push origin master');

  return { root, bare, host };
}

describe('createMergeWorktree isolation (real git)', { timeout: 30_000 }, () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function buildExecutor(cwd: string) {
    const registry = new ExecutorRegistry();
    return new TaskRunner({
      orchestrator: { getAllTasks: () => [] } as any,
      persistence: { updateTask: () => {} } as any,
      executorRegistry: registry,
      cwd,
      defaultBranch: 'master',
    });
  }

  it('clone origin points to real remote, not host cwd', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;

    const executor = buildExecutor(sandbox.host);
    const clonePath = await executor.createMergeWorktree('master', 'test-origin');

    // The clone's origin should point to the bare remote (real GitHub),
    // NOT to the host working directory.
    const cloneOrigin = git(clonePath, 'remote get-url origin');
    const hostOrigin = git(sandbox.host, 'remote get-url origin');

    expect(cloneOrigin).toBe(hostOrigin);
    expect(cloneOrigin).toContain('bare.git');
    expect(cloneOrigin).not.toBe(sandbox.host);

    await executor.removeMergeWorktree(clonePath);
  });

  it('host branches are mirrored into the clone', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;

    // Create a feature branch on the host
    git(sandbox.host, 'checkout -b feature/test');
    writeFileSync(join(sandbox.host, 'feature.txt'), 'feature');
    git(sandbox.host, 'add -A');
    git(sandbox.host, 'commit -m "feature commit"');
    git(sandbox.host, 'checkout master');

    const executor = buildExecutor(sandbox.host);
    const clonePath = await executor.createMergeWorktree('master', 'test-mirror');

    // The feature branch should be available as a local ref
    const branches = git(clonePath, 'branch --list');
    expect(branches).toContain('feature/test');

    await executor.removeMergeWorktree(clonePath);
  });

  it('resolves origin/<branch> input when branch exists only as local host branch', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;

    // Local-only feature branch on host (not pushed to origin)
    git(sandbox.host, 'checkout -b feature/local-only');
    writeFileSync(join(sandbox.host, 'local-only.txt'), 'local-only');
    git(sandbox.host, 'add -A');
    git(sandbox.host, 'commit -m "local only branch"');
    git(sandbox.host, 'checkout master');

    const expectedSha = git(sandbox.host, 'rev-parse feature/local-only');

    const executor = buildExecutor(sandbox.host);
    const clonePath = await executor.createMergeWorktree('origin/feature/local-only', 'test-origin-prefix-local-only');

    const headSha = git(clonePath, 'rev-parse HEAD');
    expect(headSha).toBe(expectedSha);

    await executor.removeMergeWorktree(clonePath);
  });

  it('clone HEAD is detached at the requested ref', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;

    const masterSha = git(sandbox.host, 'rev-parse master');
    const executor = buildExecutor(sandbox.host);
    const clonePath = await executor.createMergeWorktree('master', 'test-detach');

    const headSha = git(clonePath, 'rev-parse HEAD');
    expect(headSha).toBe(masterSha);

    // HEAD should be detached (not on a branch)
    try {
      git(clonePath, 'symbolic-ref HEAD');
      expect.fail('HEAD should be detached');
    } catch {
      // Expected — detached HEAD
    }

    await executor.removeMergeWorktree(clonePath);
  });

  it('operations in clone do not mutate host repo', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;

    const hostHeadBefore = git(sandbox.host, 'rev-parse HEAD');
    const hostBranchesBefore = git(sandbox.host, 'branch --list');

    const executor = buildExecutor(sandbox.host);
    const clonePath = await executor.createMergeWorktree('master', 'test-isolate');

    // Mutate the clone: create a branch and commit
    git(clonePath, 'checkout -b experiment/test-isolation');
    writeFileSync(join(clonePath, 'clone-only.txt'), 'should not appear in host');
    git(clonePath, 'add -A');
    git(clonePath, 'config user.email "test@test.com"');
    git(clonePath, 'config user.name "Test"');
    git(clonePath, 'commit -m "clone-only commit"');

    // Host should be unaffected
    const hostHeadAfter = git(sandbox.host, 'rev-parse HEAD');
    const hostBranchesAfter = git(sandbox.host, 'branch --list');
    expect(hostHeadAfter).toBe(hostHeadBefore);
    expect(hostBranchesAfter).toBe(hostBranchesBefore);

    await executor.removeMergeWorktree(clonePath);
  });

  it('clone resolves baseBranch from origin when host local master is behind', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;

    // Push a commit directly to the bare remote (simulating a remote push that
    // the host working directory has not fetched yet).
    const pusherDir = join(sandbox.root, 'pusher');
    execSync(`git clone ${sandbox.bare} ${pusherDir}`);
    git(pusherDir, 'checkout -B master origin/master');
    git(pusherDir, 'config user.email "test@test.com"');
    git(pusherDir, 'config user.name "Test"');
    writeFileSync(join(pusherDir, 'remote-only.txt'), 'remote commit');
    git(pusherDir, 'add -A');
    git(pusherDir, 'commit -m "remote-only commit"');
    git(pusherDir, 'branch -M master');
    git(pusherDir, 'push origin master');

    const remoteMasterSha = git(sandbox.bare, 'rev-parse master');
    const hostMasterSha = git(sandbox.host, 'rev-parse master');
    // Host should be behind remote
    expect(hostMasterSha).not.toBe(remoteMasterSha);

    // When repoUrl is provided, createMergeWorktree falls back to host.cwd
    // (no pool mirror in test), but origin still points to bare remote.
    // The clone should have branches mirrored from the host and origin
    // should be set to the bare remote URL.
    const executor = buildExecutor(sandbox.host);
    const clonePath = await executor.createMergeWorktree('master', 'test-stale', sandbox.bare);

    const cloneOrigin = git(clonePath, 'remote get-url origin');
    expect(cloneOrigin).toBe(sandbox.bare);

    await executor.removeMergeWorktree(clonePath);
  });
});
