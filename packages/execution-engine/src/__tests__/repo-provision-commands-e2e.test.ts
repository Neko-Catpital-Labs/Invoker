/**
 * End-to-end test: repoProvisionCommands against a real git repo.
 *
 * Proves the repoUrl -> provision command mapping works against a real
 * `file://` repo checkout (real git clone/worktree, no mocked
 * child_process), not just the mocked-spawn unit tests in
 * worktree-executor.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import { WorktreeExecutor } from '../worktree-executor.js';

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

async function runToCompletion(
  executor: WorktreeExecutor,
  request: WorkRequest,
): Promise<WorkResponse> {
  const handle = await executor.start(request);
  return new Promise((resolve) => {
    executor.onComplete(handle, (response) => resolve(response));
  });
}

describe('repoProvisionCommands (real git, no mocked spawn)', { timeout: 30_000 }, () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('runs the repo-specific command against a real non-Node repo instead of the pool default', async () => {
    root = mkdtempSync(join(tmpdir(), 'repo-provision-e2e-'));

    // A repo with no package.json, mirroring a non-Node target repoUrl
    // (e.g. a data-only repo) — the pool default `pnpm install
    // --frozen-lockfile` would fail against this checkout every time.
    const bare = join(root, 'bare.git');
    execSync(`git init --bare -b master ${bare}`);
    const seed = join(root, 'seed');
    execSync(`git clone ${bare} ${seed}`);
    git(seed, 'config user.email "test@test.com"');
    git(seed, 'config user.name "Test"');
    writeFileSync(join(seed, 'README.md'), 'not a node project\n');
    git(seed, 'add -A');
    git(seed, 'commit -m "seed"');
    git(seed, 'push origin master');

    const repoUrl = `file://${bare}`;
    const markerRelPath = 'provision-ran.txt';

    const executor = new WorktreeExecutor({
      cacheDir: join(root, 'cache'),
      worktreeBaseDir: join(root, 'worktrees'),
      // Pool default: would fail immediately (ERR_PNPM_NO_PKG_MANIFEST) if
      // it were the command that actually ran for this repoUrl.
      provisionCommand: 'pnpm install --frozen-lockfile',
      repoProvisionCommands: {
        [repoUrl]: `echo real-provisioning-ran > ${markerRelPath}`,
      },
    });

    const request: WorkRequest = {
      requestId: 'req-e2e-1',
      actionId: 'e2e-repo-provision-command',
      actionType: 'command',
      inputs: {
        command: `test -f ${markerRelPath}`,
        repoUrl,
        baseBranch: 'master',
      },
      callbackUrl: 'http://localhost:0/callback',
      timestamps: { createdAt: new Date().toISOString() },
    };

    const response = await runToCompletion(executor, request);

    // The task command (`test -f provision-ran.txt`) only exits 0 if the
    // repo-specific override actually ran and wrote the marker file --
    // the pool default (`pnpm install --frozen-lockfile`) would have
    // failed outright against this non-Node repo before the task command
    // ever got a chance to run.
    expect(response.status).toBe('completed');
    expect(response.outputs.exitCode).toBe(0);

    const commitHash = response.outputs.commitHash;
    if (!commitHash) throw new Error('expected a commitHash on the completed response');
    const markerContent = execSync(`git --git-dir="${bare}" show ${commitHash}:${markerRelPath}`).toString().trim();
    expect(markerContent).toBe('real-provisioning-ran');

    await executor.destroyAll();
  });

  it('still fails with the pool default when the repo has no repoProvisionCommands entry', async () => {
    root = mkdtempSync(join(tmpdir(), 'repo-provision-e2e-noop-'));

    const bare = join(root, 'bare.git');
    execSync(`git init --bare -b master ${bare}`);
    const seed = join(root, 'seed');
    execSync(`git clone ${bare} ${seed}`);
    git(seed, 'config user.email "test@test.com"');
    git(seed, 'config user.name "Test"');
    writeFileSync(join(seed, 'README.md'), 'not a node project\n');
    git(seed, 'add -A');
    git(seed, 'commit -m "seed"');
    git(seed, 'push origin master');

    const repoUrl = `file://${bare}`;

    const executor = new WorktreeExecutor({
      cacheDir: join(root, 'cache'),
      worktreeBaseDir: join(root, 'worktrees'),
      // Deterministically-failing stand-in for a pool default that doesn't
      // apply to this repo (real production case: `pnpm install
      // --frozen-lockfile` against a repo with no package.json).
      provisionCommand: 'test -f this-file-does-not-exist',
      // No repoProvisionCommands entry for repoUrl -- unmapped repos keep
      // today's behavior on purpose, by design (see the previous slice).
    });

    const request: WorkRequest = {
      requestId: 'req-e2e-2',
      actionId: 'e2e-repo-provision-command-unmapped',
      actionType: 'command',
      inputs: {
        command: 'echo should-never-run',
        repoUrl,
        baseBranch: 'master',
      },
      callbackUrl: 'http://localhost:0/callback',
      timestamps: { createdAt: new Date().toISOString() },
    };

    await expect(executor.start(request)).rejects.toThrow(/Worktree provisioning failed/);

    await executor.destroyAll();
  });
});
