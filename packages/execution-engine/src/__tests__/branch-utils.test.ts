import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import {
  computeBranchHash,
  bashPreserveOrReset,
  bashMergeUpstreams,
  bashEnsureRef,
  parsePreserveResult,
  parseMergeError,
  runBashLocal,
} from '../branch-utils.js';

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'branch-utils-test-'));
  execSync('git init -b master', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, 'initial.txt'), 'initial content');
  execSync('git add -A && git commit -m "initial"', { cwd: dir });
  return dir;
}

function gitExec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8' }).trim();
}

// ---------------------------------------------------------------------------
// computeBranchHash (pure TypeScript, no git)
// ---------------------------------------------------------------------------

describe('computeBranchHash', () => {
  it('is deterministic: same inputs produce same hash', () => {
    const a = computeBranchHash('task-1', 'echo hi', undefined, [], 'abc123');
    const b = computeBranchHash('task-1', 'echo hi', undefined, [], 'abc123');
    expect(a).toBe(b);
  });

  it('is sensitive to command changes', () => {
    const a = computeBranchHash('task-1', 'echo a', undefined, [], 'abc');
    const b = computeBranchHash('task-1', 'echo b', undefined, [], 'abc');
    expect(a).not.toBe(b);
  });

  it('is sensitive to prompt changes', () => {
    const a = computeBranchHash('task-1', undefined, 'prompt a', [], 'abc');
    const b = computeBranchHash('task-1', undefined, 'prompt b', [], 'abc');
    expect(a).not.toBe(b);
  });

  it('is sensitive to baseHead changes', () => {
    const a = computeBranchHash('task-1', 'cmd', undefined, [], 'head-a');
    const b = computeBranchHash('task-1', 'cmd', undefined, [], 'head-b');
    expect(a).not.toBe(b);
  });

  it('is sensitive to upstream commit changes', () => {
    const a = computeBranchHash('task-1', 'cmd', undefined, ['c1'], 'abc');
    const b = computeBranchHash('task-1', 'cmd', undefined, ['c2'], 'abc');
    expect(a).not.toBe(b);
  });

  it('is order-independent for upstream commits', () => {
    const a = computeBranchHash('task-1', 'cmd', undefined, ['c1', 'c2'], 'abc');
    const b = computeBranchHash('task-1', 'cmd', undefined, ['c2', 'c1'], 'abc');
    expect(a).toBe(b);
  });

  it('is sensitive to salt changes', () => {
    const a = computeBranchHash('task-1', 'cmd', undefined, [], 'abc', 'salt-a');
    const b = computeBranchHash('task-1', 'cmd', undefined, [], 'abc', 'salt-b');
    expect(a).not.toBe(b);
  });

  it('produces 8-character hex string', () => {
    const h = computeBranchHash('task-1', 'cmd', undefined, [], 'abc');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// parsePreserveResult
// ---------------------------------------------------------------------------

describe('parsePreserveResult', () => {
  it('parses preserved=true', () => {
    const result = parsePreserveResult('PRESERVED=1\nBASE_SHA=abc123\n');
    expect(result).toEqual({ preserved: true, baseSha: 'abc123' });
  });

  it('parses preserved=false', () => {
    const result = parsePreserveResult('PRESERVED=0\nBASE_SHA=def456\n');
    expect(result).toEqual({ preserved: false, baseSha: 'def456' });
  });

  it('handles extra output lines before the structured output', () => {
    const result = parsePreserveResult('some git noise\nPRESERVED=1\nBASE_SHA=abc\n');
    expect(result).toEqual({ preserved: true, baseSha: 'abc' });
  });

  it('throws when BASE_SHA is missing', () => {
    expect(() => parsePreserveResult('PRESERVED=1\n')).toThrow('missing BASE_SHA');
  });
});

// ---------------------------------------------------------------------------
// parseMergeError
// ---------------------------------------------------------------------------

describe('parseMergeError', () => {
  it('parses merge conflict stderr', () => {
    const err = parseMergeError(31, 'MERGE_CONFLICT_BRANCH=feature-a\nMERGE_CONFLICT_FILE=file1.txt');
    expect(err.failedBranch).toBe('feature-a');
    expect(err.conflictFiles).toEqual(['file1.txt']);
  });

  it('parses missing ref stderr', () => {
    const err = parseMergeError(30, 'MISSING_REF=experiment/gone');
    expect(err.failedBranch).toBe('experiment/gone');
    expect(err.conflictFiles).toEqual([]);
  });

  it('returns empty failedBranch when stderr has no known markers', () => {
    const err = parseMergeError(1, 'some random error');
    expect(err.failedBranch).toBe('');
  });
});

// ---------------------------------------------------------------------------
// bashPreserveOrReset: SSH-style paths must expand $HOME / ~ in remote bash
// ---------------------------------------------------------------------------

describe('bashPreserveOrReset (SSH path quoting)', () => {
  it('double-quotes $HOME/... so git -C sees a real path on the remote', () => {
    const script = bashPreserveOrReset({
      repoDir: '$HOME/.invoker/repos/deadbeef',
      worktreeDir: '$HOME/.invoker/worktrees/deadbeef/branch-san',
      branch: 'experiment/task-abc12345',
      base: 'master',
    });
    expect(script).toContain('REPO_DIR="$HOME/.invoker/repos/deadbeef"');
    expect(script).not.toContain("REPO_DIR='$HOME");
    expect(script).toContain('WT_DIR="$HOME/.invoker/worktrees/deadbeef/branch-san"');
  });

  it('maps ~/ prefix to "$HOME/..." in generated assignments', () => {
    const script = bashPreserveOrReset({
      repoDir: '~/.invoker/repos/x',
      worktreeDir: '~/.invoker/wt/x',
      branch: 'b',
      base: 'master',
    });
    expect(script).toContain('REPO_DIR="$HOME/.invoker/repos/x"');
    expect(script).toContain('WT_DIR="$HOME/.invoker/wt/x"');
  });
});

describe('bashMergeUpstreams (SSH path quoting)', () => {
  it('double-quotes $HOME/... for WT_DIR', () => {
    const script = bashMergeUpstreams({
      worktreeDir: '$HOME/.invoker/wt/x',
      upstreamBranches: ['upstream-branch'],
      skipAncestors: false,
    });
    expect(script).toContain('WT_DIR="$HOME/.invoker/wt/x"');
    expect(script).not.toContain("WT_DIR='$HOME");
  });
});

// ---------------------------------------------------------------------------
// runBashLocal
// ---------------------------------------------------------------------------

describe('runBashLocal', () => {
  it('returns stdout on success', async () => {
    const result = await runBashLocal('echo hello');
    expect(result.trim()).toBe('hello');
  });

  it('rejects on non-zero exit', async () => {
    await expect(runBashLocal('exit 1')).rejects.toThrow('bash exited with code 1');
  });

  it('passes cwd to the child process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runbash-'));
    try {
      const result = await runBashLocal('pwd', dir);
      expect(result.trim()).toContain(dir.split('/').pop());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// bashPreserveOrReset (sandbox git repos)
// ---------------------------------------------------------------------------

describe('bashPreserveOrReset', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempRepo();
  });

  afterEach(() => {
    // Clean up worktrees before removing dir
    try { execSync('git worktree prune', { cwd: repoDir }); } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe('checkout mode', () => {
    it('force-creates branch from base when branch does not exist', async () => {
      const script = bashPreserveOrReset({
        repoDir,
        branch: 'invoker/new-task',
        base: 'master',
      });
      const stdout = await runBashLocal(script);
      const result = parsePreserveResult(stdout);

      expect(result.preserved).toBe(false);
      const currentBranch = gitExec('git branch --show-current', repoDir);
      expect(currentBranch).toBe('invoker/new-task');
    });

    it('preserves branch with commits ahead and merges base', async () => {
      // Create a branch with a commit ahead of master
      gitExec('git checkout -b invoker/task-a', repoDir);
      writeFileSync(join(repoDir, 'task-a.txt'), 'task work');
      gitExec('git add -A && git commit -m "task commit"', repoDir);
      gitExec('git checkout master', repoDir);

      // Move master forward
      writeFileSync(join(repoDir, 'master-update.txt'), 'new base');
      gitExec('git add -A && git commit -m "base update"', repoDir);

      const script = bashPreserveOrReset({
        repoDir,
        branch: 'invoker/task-a',
        base: 'master',
      });
      const stdout = await runBashLocal(script);
      const result = parsePreserveResult(stdout);

      expect(result.preserved).toBe(true);
      // Should be on the preserved branch with both files
      const currentBranch = gitExec('git branch --show-current', repoDir);
      expect(currentBranch).toBe('invoker/task-a');
      expect(readFileSync(join(repoDir, 'task-a.txt'), 'utf-8')).toBe('task work');
      expect(readFileSync(join(repoDir, 'master-update.txt'), 'utf-8')).toBe('new base');
    });

    it('force-resets when branch exists but has 0 commits ahead', async () => {
      // Create branch at same point as master
      gitExec('git checkout -b invoker/stale', repoDir);
      gitExec('git checkout master', repoDir);

      const script = bashPreserveOrReset({
        repoDir,
        branch: 'invoker/stale',
        base: 'master',
      });
      const stdout = await runBashLocal(script);
      const result = parsePreserveResult(stdout);

      expect(result.preserved).toBe(false);
    });
  });

  describe('worktree mode', () => {
    it('force-creates worktree from base when branch does not exist', async () => {
      const wtDir = join(repoDir, '..', 'wt-test-' + Date.now());

      const script = bashPreserveOrReset({
        repoDir,
        worktreeDir: wtDir,
        branch: 'invoker/wt-new',
        base: 'master',
      });
      const stdout = await runBashLocal(script);
      const result = parsePreserveResult(stdout);

      expect(result.preserved).toBe(false);
      const currentBranch = gitExec('git branch --show-current', wtDir);
      expect(currentBranch).toBe('invoker/wt-new');

      // Cleanup
      execSync(`git worktree remove --force "${wtDir}"`, { cwd: repoDir });
    });

    it('preserves worktree branch with commits ahead', async () => {
      // Create a branch with commits ahead
      gitExec('git checkout -b invoker/wt-preserve', repoDir);
      writeFileSync(join(repoDir, 'task.txt'), 'preserved work');
      gitExec('git add -A && git commit -m "task commit"', repoDir);
      gitExec('git checkout master', repoDir);

      // Move master forward
      writeFileSync(join(repoDir, 'base.txt'), 'base work');
      gitExec('git add -A && git commit -m "base commit"', repoDir);

      const wtDir = join(repoDir, '..', 'wt-preserve-' + Date.now());

      const script = bashPreserveOrReset({
        repoDir,
        worktreeDir: wtDir,
        branch: 'invoker/wt-preserve',
        base: 'master',
      });
      const stdout = await runBashLocal(script);
      const result = parsePreserveResult(stdout);

      expect(result.preserved).toBe(true);
      expect(readFileSync(join(wtDir, 'task.txt'), 'utf-8')).toBe('preserved work');
      expect(readFileSync(join(wtDir, 'base.txt'), 'utf-8')).toBe('base work');

      // Cleanup
      execSync(`git worktree remove --force "${wtDir}"`, { cwd: repoDir });
    });
  });
});

// ---------------------------------------------------------------------------
// bashMergeUpstreams (sandbox git repos)
// ---------------------------------------------------------------------------

describe('bashMergeUpstreams', () => {
  let repoDir: string;
  let wtDir: string;

  beforeEach(() => {
    repoDir = createTempRepo();
    wtDir = join(repoDir, '..', 'merge-wt-' + Date.now());
    // Create the worktree on a new branch
    execSync(`git worktree add -b invoker/merge-test "${wtDir}" master`, { cwd: repoDir });
  });

  afterEach(() => {
    try { execSync(`git worktree remove --force "${wtDir}"`, { cwd: repoDir }); } catch { /* ignore */ }
    try { execSync('git worktree prune', { cwd: repoDir }); } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns immediately when no branches to merge', async () => {
    const script = bashMergeUpstreams({
      worktreeDir: wtDir,
      upstreamBranches: [],
    });
    const result = await runBashLocal(script);
    expect(result).toBeDefined();
  });

  it('merges an upstream branch', async () => {
    // Create an upstream branch with a change
    gitExec('git checkout -b upstream-a', repoDir);
    writeFileSync(join(repoDir, 'upstream-a.txt'), 'from upstream a');
    gitExec('git add -A && git commit -m "upstream a commit"', repoDir);
    gitExec('git checkout master', repoDir);

    const script = bashMergeUpstreams({
      worktreeDir: wtDir,
      upstreamBranches: ['upstream-a'],
    });
    await runBashLocal(script);

    expect(readFileSync(join(wtDir, 'upstream-a.txt'), 'utf-8')).toBe('from upstream a');
  });

  it('skips branches already in ancestry', async () => {
    // master is already an ancestor of the worktree HEAD
    const script = bashMergeUpstreams({
      worktreeDir: wtDir,
      upstreamBranches: ['master'],
      skipAncestors: true,
    });
    const stdout = await runBashLocal(script);
    expect(stdout).toContain('SKIPPED=master');
  });

  it('skips missing refs gracefully (exit 0)', async () => {
    const script = bashMergeUpstreams({
      worktreeDir: wtDir,
      upstreamBranches: ['nonexistent-branch'],
    });
    // Should succeed (exit 0) and skip the missing branch
    const stdout = await runBashLocal(script);
    expect(stdout).toContain('SKIPPED_MISSING_REF=nonexistent-branch');
  });

  it('exits 31 on merge conflict and aborts cleanly', async () => {
    // Create two branches that conflict
    gitExec('git checkout -b conflict-branch', repoDir);
    writeFileSync(join(repoDir, 'initial.txt'), 'conflicting content');
    gitExec('git add -A && git commit -m "conflict commit"', repoDir);
    gitExec('git checkout master', repoDir);

    // Modify the same file in the worktree
    writeFileSync(join(wtDir, 'initial.txt'), 'worktree content');
    gitExec('git add -A && git commit -m "worktree commit"', wtDir);

    const script = bashMergeUpstreams({
      worktreeDir: wtDir,
      upstreamBranches: ['conflict-branch'],
    });
    try {
      await runBashLocal(script);
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.exitCode).toBe(31);
      const mergeErr = parseMergeError(31, err.stderr);
      expect(mergeErr.failedBranch).toBe('conflict-branch');
    }

    // Verify repo is clean after abort
    const status = gitExec('git status --porcelain', wtDir);
    expect(status).toBe('');
  });

  it('auto-resolves tsbuildinfo-only merge conflicts and continues', async () => {
    // Create upstream branch touching only a generated artifact path.
    gitExec('git checkout -b conflict-buildinfo', repoDir);
    const generated = join(repoDir, 'packages', 'protocol');
    execSync(`mkdir -p "${generated}"`);
    writeFileSync(join(generated, 'tsconfig.tsbuildinfo'), 'upstream-generated');
    gitExec('git add -A && git commit -m "upstream generated artifact"', repoDir);
    gitExec('git checkout master', repoDir);

    // Create conflicting local version in worktree.
    const wtGenerated = join(wtDir, 'packages', 'protocol');
    execSync(`mkdir -p "${wtGenerated}"`);
    writeFileSync(join(wtGenerated, 'tsconfig.tsbuildinfo'), 'worktree-generated');
    gitExec('git add -A && git commit -m "worktree generated artifact"', wtDir);

    const script = bashMergeUpstreams({
      worktreeDir: wtDir,
      upstreamBranches: ['conflict-buildinfo'],
    });
    const stdout = await runBashLocal(script);

    expect(stdout).toContain('AUTO_RESOLVED_GENERATED_CONFLICTS=conflict-buildinfo');
    // We intentionally keep the current branch's generated artifact.
    expect(readFileSync(join(wtGenerated, 'tsconfig.tsbuildinfo'), 'utf-8')).toBe('worktree-generated');
    expect(gitExec('git status --porcelain', wtDir)).toBe('');
  });

  it('merges multiple branches in order', async () => {
    // Create two upstream branches
    gitExec('git checkout -b upstream-x', repoDir);
    writeFileSync(join(repoDir, 'x.txt'), 'x');
    gitExec('git add -A && git commit -m "x"', repoDir);
    gitExec('git checkout master', repoDir);

    gitExec('git checkout -b upstream-y', repoDir);
    writeFileSync(join(repoDir, 'y.txt'), 'y');
    gitExec('git add -A && git commit -m "y"', repoDir);
    gitExec('git checkout master', repoDir);

    const script = bashMergeUpstreams({
      worktreeDir: wtDir,
      upstreamBranches: ['upstream-x', 'upstream-y'],
    });
    await runBashLocal(script);

    expect(readFileSync(join(wtDir, 'x.txt'), 'utf-8')).toBe('x');
    expect(readFileSync(join(wtDir, 'y.txt'), 'utf-8')).toBe('y');
  });

  it('resets dirty worktree state before merge to avoid false merge_conflict', async () => {
    // Upstream branch introduces a new tracked file.
    gitExec('git checkout -b upstream-clean-merge', repoDir);
    writeFileSync(join(repoDir, 'fresh.txt'), 'from-upstream');
    gitExec('git add -A && git commit -m "add fresh file"', repoDir);
    gitExec('git checkout master', repoDir);

    // Dirty the worktree with tracked + untracked files that would block merge.
    writeFileSync(join(wtDir, 'initial.txt'), 'local-dirty-change');
    writeFileSync(join(wtDir, 'scratch.tmp'), 'untracked-junk');
    // Stage tracked change so merge would definitely complain without cleanup.
    gitExec('git add initial.txt', wtDir);

    const script = bashMergeUpstreams({
      worktreeDir: wtDir,
      upstreamBranches: ['upstream-clean-merge'],
    });
    await runBashLocal(script);

    expect(readFileSync(join(wtDir, 'fresh.txt'), 'utf-8')).toBe('from-upstream');
    // Dirty tracked+untracked state should be removed by pre-merge cleanup.
    expect(gitExec('git status --porcelain', wtDir)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// bashEnsureRef (sandbox git repos)
// ---------------------------------------------------------------------------

describe('bashEnsureRef', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('exits 0 when branch exists', async () => {
    gitExec('git checkout -b test-branch', repoDir);
    gitExec('git checkout master', repoDir);

    const script = bashEnsureRef({ worktreeDir: repoDir, branch: 'test-branch' });
    await runBashLocal(script);
  });

  it('exits 30 when branch does not exist', async () => {
    const script = bashEnsureRef({ worktreeDir: repoDir, branch: 'nonexistent' });
    try {
      await runBashLocal(script);
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.exitCode).toBe(30);
    }
  });
});
