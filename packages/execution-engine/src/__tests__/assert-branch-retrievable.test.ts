/**
 * assertBranchRetrievableOnOrigin invariant tests (real git).
 *
 * Proves the "do not progress on a lost push" invariant: after a feature branch
 * is pushed, it must be retrievable from origin at the exact commit we pushed.
 * A downstream gate resolves the base ref against origin only, so a branch that
 * never landed there must fail loudly here instead of surfacing later as a
 * confusing "merge gate workspace missing" error.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertBranchRetrievableOnOrigin, type MergeRunnerHost } from '../merge-runner.js';

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? '').trim();
}

/** Minimal host: assertBranchRetrievableOnOrigin only needs cwd + execGitIn. */
function makeHost(cwd: string): MergeRunnerHost {
  return {
    cwd,
    execGitIn: async (args: string[], dir: string) => git(dir, args),
  } as unknown as MergeRunnerHost;
}

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'assert-retr-'));
  const bare = join(root, 'bare.git');
  git(root, ['init', '--bare', '-b', 'master', bare]);

  const work = join(root, 'work');
  git(root, ['clone', bare, work]);
  git(work, ['config', 'user.email', 'test@test.com']);
  git(work, ['config', 'user.name', 'Test']);
  writeFileSync(join(work, 'init.txt'), 'init');
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'initial']);
  git(work, ['branch', '-M', 'master']);
  git(work, ['push', 'origin', 'master']);
  return { root, bare, work };
}

function commitOnBranch(work: string, branch: string, file: string): void {
  git(work, ['checkout', '-b', branch]);
  writeFileSync(join(work, file), file);
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', `add ${file}`]);
}

describe('assertBranchRetrievableOnOrigin (real git)', { timeout: 30_000 }, () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('passes when the pushed branch is present on origin at the pushed commit', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;
    commitOnBranch(sandbox.work, 'plan/feature', 'feature.txt');
    git(sandbox.work, ['push', 'origin', 'plan/feature:refs/heads/plan/feature']);

    await expect(
      assertBranchRetrievableOnOrigin(makeHost(sandbox.root), sandbox.work, 'plan/feature'),
    ).resolves.toBeUndefined();
  });

  it('throws an explicit error when the branch never landed on origin', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;
    // Branch exists locally but is deliberately NOT pushed — simulates a lost push.
    commitOnBranch(sandbox.work, 'plan/feature', 'feature.txt');

    await expect(
      assertBranchRetrievableOnOrigin(makeHost(sandbox.root), sandbox.work, 'plan/feature'),
    ).rejects.toThrow(/branch "plan\/feature" is not on origin after push/);
  });

  it('throws when origin has the branch at a different commit than the local tip', async () => {
    const sandbox = createSandbox();
    root = sandbox.root;
    commitOnBranch(sandbox.work, 'plan/feature', 'feature.txt');
    git(sandbox.work, ['push', 'origin', 'plan/feature:refs/heads/plan/feature']);
    // Advance the local tip past what origin has (origin is now stale).
    writeFileSync(join(sandbox.work, 'extra.txt'), 'extra');
    git(sandbox.work, ['add', '-A']);
    git(sandbox.work, ['commit', '-m', 'local-only extra commit']);

    await expect(
      assertBranchRetrievableOnOrigin(makeHost(sandbox.root), sandbox.work, 'plan/feature'),
    ).rejects.toThrow(/push should have advanced it to/);
  });

  it('is a no-op when git is stubbed (no local tip to verify)', async () => {
    // Mocked execGitIn returns '' for every command — mirrors unit tests that
    // stub git. With no resolvable local tip there is nothing to assert.
    const host = {
      cwd: '/tmp/does-not-matter-host',
      execGitIn: async () => '',
    } as unknown as MergeRunnerHost;

    await expect(
      assertBranchRetrievableOnOrigin(host, '/tmp/does-not-matter-clone', 'plan/feature'),
    ).resolves.toBeUndefined();
  });
});
