import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { BaseFamiliar, type BaseEntry } from '../base-familiar.js';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { FamiliarHandle, TerminalSpec } from '../familiar.js';

// Concrete implementation for testing
class TestFamiliar extends BaseFamiliar<BaseEntry> {
  readonly type = 'test';

  async start(_request: WorkRequest): Promise<FamiliarHandle> {
    throw new Error('Not implemented');
  }
  async kill(_handle: FamiliarHandle): Promise<void> {}
  sendInput(_handle: FamiliarHandle, _input: string): void {}
  getTerminalSpec(_handle: FamiliarHandle): TerminalSpec | null { return null; }
  async destroyAll(): Promise<void> { this.entries.clear(); }

  // Expose protected methods for testing
  async testAutoCommit(
    cwd: string,
    actionId: string,
    meta?: {
      description?: string;
      prompt?: string;
      upstreamContext?: Array<{taskId: string; description: string; summary?: string; commitMessage?: string}>;
    },
  ): Promise<string | null> {
    return this.autoCommit(cwd, actionId, meta);
  }

  async testEnsureFeatureBranch(cwd: string, branchName: string): Promise<void> {
    return this.ensureFeatureBranch(cwd, branchName);
  }
}

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-commit-test-'));
  execSync('git init', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, 'initial.txt'), 'initial content');
  execSync('git add -A && git commit -m "initial"', { cwd: dir });
  return dir;
}

describe('BaseFamiliar.autoCommit', () => {
  let familiar: TestFamiliar;
  let tmpDir: string;

  beforeEach(() => {
    familiar = new TestFamiliar();
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('commits changes and returns hash', async () => {
    writeFileSync(join(tmpDir, 'new-file.txt'), 'new content');
    const hash = await familiar.testAutoCommit(tmpDir, 'test-action');

    expect(hash).toBeDefined();
    expect(hash).not.toBeNull();
    expect(hash!.length).toBeGreaterThan(0);

    // Verify the commit message
    const log = execSync('git log -1 --pretty=%s', { cwd: tmpDir }).toString().trim();
    expect(log).toBe('invoker: test-action');
  });

  it('returns null when no changes', async () => {
    const hash = await familiar.testAutoCommit(tmpDir, 'test-action');
    expect(hash).toBeNull();
  });

  it('returns null for non-git directories', async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'non-git-'));
    const hash = await familiar.testAutoCommit(nonGitDir, 'test-action');
    expect(hash).toBeNull();
    rmSync(nonGitDir, { recursive: true, force: true });
  });
});

describe('BaseFamiliar.ensureFeatureBranch', () => {
  let familiar: TestFamiliar;
  let tmpDir: string;

  beforeEach(() => {
    familiar = new TestFamiliar();
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a feature branch from current HEAD', async () => {
    await familiar.testEnsureFeatureBranch(tmpDir, 'task/step-1');

    const branch = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(branch).toBe('task/step-1');
  });

  it('checks out existing branch without error', async () => {
    await familiar.testEnsureFeatureBranch(tmpDir, 'task/step-1');
    // Switch away
    execSync('git checkout -b other', { cwd: tmpDir });
    // Switch back to existing branch
    await familiar.testEnsureFeatureBranch(tmpDir, 'task/step-1');

    const branch = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(branch).toBe('task/step-1');
  });

  it('creates chained branches: step2 branches off step1', async () => {
    // Create step1 branch and commit
    await familiar.testEnsureFeatureBranch(tmpDir, 'task/step-1');
    writeFileSync(join(tmpDir, 'step1.txt'), 'step1');
    await familiar.testAutoCommit(tmpDir, 'step-1');

    // Create step2 branch (from current HEAD = task/step-1)
    await familiar.testEnsureFeatureBranch(tmpDir, 'task/step-2');
    writeFileSync(join(tmpDir, 'step2.txt'), 'step2');
    await familiar.testAutoCommit(tmpDir, 'step-2');

    const branch = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(branch).toBe('task/step-2');

    // Verify ancestry: step1 commit is an ancestor of step2
    const step1Hash = execSync('git rev-parse task/step-1', { cwd: tmpDir }).toString().trim();
    execSync(`git merge-base --is-ancestor ${step1Hash} HEAD`, { cwd: tmpDir });
    // If the above didn't throw, step1 is ancestor of step2
  });

  it('three-task chain has correct branch parentage', async () => {
    for (const step of ['step-1', 'step-2', 'step-3']) {
      await familiar.testEnsureFeatureBranch(tmpDir, `task/${step}`);
      writeFileSync(join(tmpDir, `${step}.txt`), step);
      await familiar.testAutoCommit(tmpDir, step);
    }

    const step1 = execSync('git rev-parse task/step-1', { cwd: tmpDir }).toString().trim();
    const step2 = execSync('git rev-parse task/step-2', { cwd: tmpDir }).toString().trim();
    const step3 = execSync('git rev-parse task/step-3', { cwd: tmpDir }).toString().trim();

    // step1 is ancestor of step2
    execSync(`git merge-base --is-ancestor ${step1} ${step2}`, { cwd: tmpDir });
    // step2 is ancestor of step3
    execSync(`git merge-base --is-ancestor ${step2} ${step3}`, { cwd: tmpDir });

    // Verify commit messages contain task IDs
    const log = execSync('git log --all --oneline', { cwd: tmpDir }).toString();
    expect(log).toContain('step-1');
    expect(log).toContain('step-2');
    expect(log).toContain('step-3');
  });

  it('silently skips non-git directories', async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'non-git-'));
    // Should not throw
    await familiar.testEnsureFeatureBranch(nonGitDir, 'task/test');
    rmSync(nonGitDir, { recursive: true, force: true });
  });
});

// ── Helper: check git ancestry ──────────────────────────────

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    execSync(`git merge-base --is-ancestor ${ancestor} ${descendant}`, { cwd });
    return true;
  } catch {
    return false;
  }
}

function getCommitBody(cwd: string, ref = 'HEAD'): string {
  return execSync(`git log -1 --format=%B ${ref}`, { cwd }).toString().trim();
}

function getCommitSubject(cwd: string, ref = 'HEAD'): string {
  return execSync(`git log -1 --pretty=%s ${ref}`, { cwd }).toString().trim();
}

// ── A. autoCommit with meta ─────────────────────────────────

describe('autoCommit with meta', () => {
  let familiar: TestFamiliar;
  let tmpDir: string;

  beforeEach(() => {
    familiar = new TestFamiliar();
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes description in commit headline', async () => {
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    await familiar.testAutoCommit(tmpDir, 'task-1', {
      description: 'Implement auth middleware',
    });

    const subject = getCommitSubject(tmpDir);
    expect(subject).toBe('invoker: task-1 — Implement auth middleware');
  });

  it('includes Prompt section in commit body', async () => {
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    await familiar.testAutoCommit(tmpDir, 'task-1', {
      prompt: 'Add login endpoint',
    });

    const body = getCommitBody(tmpDir);
    expect(body).toContain('## Prompt');
    expect(body).toContain('Add login endpoint');
  });

  it('includes Upstream Context section with task entries', async () => {
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    await familiar.testAutoCommit(tmpDir, 'task-2', {
      upstreamContext: [
        { taskId: 'task-1', description: 'Setup database', summary: 'created schema' },
      ],
    });

    const body = getCommitBody(tmpDir);
    expect(body).toContain('## Upstream Context');
    expect(body).toContain('task-1: Setup database');
    expect(body).toContain('created schema');
  });

  it('prefers commitMessage first line over summary in upstream context', async () => {
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    await familiar.testAutoCommit(tmpDir, 'task-2', {
      upstreamContext: [
        {
          taskId: 'task-1',
          description: 'Setup database',
          summary: 'branch=experiment/task-1 commit=abc123',
          commitMessage: 'invoker: task-1 — Setup database\n\n## Prompt\nCreate tables',
        },
      ],
    });

    const body = getCommitBody(tmpDir);
    expect(body).toContain('## Upstream Context');
    // Should use first line of commitMessage, not the raw summary
    expect(body).toContain('invoker: task-1 — Setup database');
    expect(body).not.toContain('branch=experiment/task-1');
  });
});

// ── B. Commit context propagation ───────────────────────────

describe('commit context propagation', () => {
  let familiar: TestFamiliar;
  let tmpDir: string;

  beforeEach(() => {
    familiar = new TestFamiliar();
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('downstream task reads upstream commit message in context', async () => {
    // Task A commits
    writeFileSync(join(tmpDir, 'a.txt'), 'task-a work');
    await familiar.testAutoCommit(tmpDir, 'task-a', {
      description: 'Implement auth',
    });
    const commitA = getCommitBody(tmpDir);

    // Task B uses A's commit message as upstream context
    writeFileSync(join(tmpDir, 'b.txt'), 'task-b work');
    await familiar.testAutoCommit(tmpDir, 'task-b', {
      description: 'Add login page',
      upstreamContext: [
        { taskId: 'task-a', description: 'Implement auth', commitMessage: commitA },
      ],
    });

    const commitB = getCommitBody(tmpDir);
    expect(commitB).toContain('## Upstream Context');
    expect(commitB).toContain('task-a: Implement auth');
    expect(commitB).toContain('invoker: task-a — Implement auth');
  });

  it('fan-out: two downstream tasks both read same upstream commit', async () => {
    // Task A commits
    writeFileSync(join(tmpDir, 'a.txt'), 'task-a work');
    await familiar.testAutoCommit(tmpDir, 'task-a', {
      description: 'Shared setup',
    });
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
    const commitA = getCommitBody(tmpDir);

    // Task B branches from A
    execSync('git checkout -b task-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'b.txt'), 'task-b work');
    await familiar.testAutoCommit(tmpDir, 'task-b', {
      description: 'Feature B',
      upstreamContext: [
        { taskId: 'task-a', description: 'Shared setup', commitMessage: commitA },
      ],
    });

    // Task C branches from A
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-c', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'c.txt'), 'task-c work');
    await familiar.testAutoCommit(tmpDir, 'task-c', {
      description: 'Feature C',
      upstreamContext: [
        { taskId: 'task-a', description: 'Shared setup', commitMessage: commitA },
      ],
    });

    // Both B and C reference A
    const commitB = getCommitBody(tmpDir, 'task-b');
    const commitC = getCommitBody(tmpDir, 'task-c');
    expect(commitB).toContain('task-a: Shared setup');
    expect(commitC).toContain('task-a: Shared setup');

    // A is ancestor of both B and C
    expect(isAncestor(tmpDir, hashA, 'task-b')).toBe(true);
    expect(isAncestor(tmpDir, hashA, 'task-c')).toBe(true);
  });

  it('chain: A → B → C, C sees both A and B in upstream context', async () => {
    // Task A
    writeFileSync(join(tmpDir, 'a.txt'), 'a');
    await familiar.testAutoCommit(tmpDir, 'task-a', { description: 'Step A' });
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
    const commitA = getCommitBody(tmpDir);

    // Task B
    writeFileSync(join(tmpDir, 'b.txt'), 'b');
    await familiar.testAutoCommit(tmpDir, 'task-b', {
      description: 'Step B',
      upstreamContext: [
        { taskId: 'task-a', description: 'Step A', commitMessage: commitA },
      ],
    });
    const hashB = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
    const commitB = getCommitBody(tmpDir);

    // Task C with both A and B in upstream context
    writeFileSync(join(tmpDir, 'c.txt'), 'c');
    await familiar.testAutoCommit(tmpDir, 'task-c', {
      description: 'Step C',
      upstreamContext: [
        { taskId: 'task-a', description: 'Step A', commitMessage: commitA },
        { taskId: 'task-b', description: 'Step B', commitMessage: commitB },
      ],
    });

    const commitC = getCommitBody(tmpDir);
    expect(commitC).toContain('task-a: Step A');
    expect(commitC).toContain('task-b: Step B');

    // Ancestry chain
    expect(isAncestor(tmpDir, hashA, hashB)).toBe(true);
    expect(isAncestor(tmpDir, hashB, 'HEAD')).toBe(true);
  });
});

// ── C. Diamond dependency merge ─────────────────────────────

describe('diamond dependency merge', () => {
  let familiar: TestFamiliar;
  let tmpDir: string;

  beforeEach(() => {
    familiar = new TestFamiliar();
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('diamond: A→B, A→C, B+C→D merges both branches', async () => {
    // A: initial commit (already exists from createTempRepo)
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // B: branch from A with unique file
    execSync('git checkout -b task-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'b.txt'), 'b-work');
    await familiar.testAutoCommit(tmpDir, 'task-b', { description: 'Feature B' });
    const hashB = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // C: branch from A with unique file
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-c', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'c.txt'), 'c-work');
    await familiar.testAutoCommit(tmpDir, 'task-c', { description: 'Feature C' });
    const hashC = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // D: merge B then C (simulating worktree merge strategy)
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-d', { cwd: tmpDir });
    execSync(`git merge -m "Merge upstream task-b" task-b`, { cwd: tmpDir });
    execSync(`git merge -m "Merge upstream task-c" task-c`, { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'd.txt'), 'd-work');
    await familiar.testAutoCommit(tmpDir, 'task-d', {
      description: 'Combine B and C',
      upstreamContext: [
        { taskId: 'task-b', description: 'Feature B', commitMessage: getCommitBody(tmpDir, hashB) },
        { taskId: 'task-c', description: 'Feature C', commitMessage: getCommitBody(tmpDir, hashC) },
      ],
    });

    // Verify ancestry
    expect(isAncestor(tmpDir, hashA, 'HEAD')).toBe(true);
    expect(isAncestor(tmpDir, hashB, 'HEAD')).toBe(true);
    expect(isAncestor(tmpDir, hashC, 'HEAD')).toBe(true);

    // Verify D contains files from both B and C
    expect(existsSync(join(tmpDir, 'b.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'c.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'd.txt'))).toBe(true);

    // Verify upstream context
    const commitD = getCommitBody(tmpDir);
    expect(commitD).toContain('task-b: Feature B');
    expect(commitD).toContain('task-c: Feature C');
  });

  it('diamond merge order: first dependency merged first', async () => {
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // B and C branch from A
    execSync('git checkout -b task-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'b.txt'), 'b');
    execSync('git add -A && git commit -m "task-b commit"', { cwd: tmpDir });

    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-c', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'c.txt'), 'c');
    execSync('git add -A && git commit -m "task-c commit"', { cwd: tmpDir });

    // D: make own commit first (so merges can't fast-forward), then merge B and C
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-d', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'd-setup.txt'), 'd-setup');
    execSync('git add -A && git commit -m "task-d setup"', { cwd: tmpDir });
    execSync('git merge -m "Merge upstream task-b" task-b', { cwd: tmpDir });
    execSync('git merge -m "Merge upstream task-c" task-c', { cwd: tmpDir });

    // Check merge log order (most recent first in git log)
    const mergeLog = execSync('git log --merges --oneline', { cwd: tmpDir }).toString();
    const lines = mergeLog.trim().split('\n');
    expect(lines[0]).toContain('task-c');
    expect(lines[1]).toContain('task-b');
  });

  it('diamond with conflict triggers merge failure and abort', async () => {
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // B modifies shared file
    execSync('git checkout -b task-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'shared.txt'), 'version-b');
    execSync('git add -A && git commit -m "task-b: modify shared"', { cwd: tmpDir });

    // C modifies same file differently
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-c', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'shared.txt'), 'version-c');
    execSync('git add -A && git commit -m "task-c: modify shared"', { cwd: tmpDir });

    // D: merge B succeeds, merge C should conflict
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-d', { cwd: tmpDir });
    execSync('git merge -m "Merge upstream task-b" task-b', { cwd: tmpDir });

    // Merging C should fail
    let mergeError: Error | null = null;
    try {
      execSync('git merge -m "Merge upstream task-c" task-c', { cwd: tmpDir });
    } catch (err) {
      mergeError = err as Error;
    }
    expect(mergeError).not.toBeNull();

    // Abort the merge to clean up
    execSync('git merge --abort', { cwd: tmpDir });

    // Worktree is clean after abort
    const status = execSync('git status --porcelain', { cwd: tmpDir }).toString().trim();
    expect(status).toBe('');
  });

  it('diamond: D upstream context has both B and C commit messages', async () => {
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync('git checkout -b task-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'b.txt'), 'b');
    await familiar.testAutoCommit(tmpDir, 'task-b', { description: 'Implement B' });
    const hashB = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-c', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'c.txt'), 'c');
    await familiar.testAutoCommit(tmpDir, 'task-c', { description: 'Implement C' });
    const hashC = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-d', { cwd: tmpDir });
    execSync(`git merge -m "Merge upstream task-b" task-b`, { cwd: tmpDir });
    execSync(`git merge -m "Merge upstream task-c" task-c`, { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'd.txt'), 'd');
    await familiar.testAutoCommit(tmpDir, 'task-d', {
      description: 'Combine results',
      upstreamContext: [
        { taskId: 'task-b', description: 'Implement B', commitMessage: getCommitBody(tmpDir, hashB) },
        { taskId: 'task-c', description: 'Implement C', commitMessage: getCommitBody(tmpDir, hashC) },
      ],
    });

    const body = getCommitBody(tmpDir);
    // Should use commitMessage headlines, not raw summaries
    expect(body).toContain('task-b: Implement B → invoker: task-b — Implement B');
    expect(body).toContain('task-c: Implement C → invoker: task-c — Implement C');
  });

  it('deep diamond: A→B→D, A→C→D→E with different path lengths', async () => {
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // B from A
    execSync('git checkout -b task-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'b.txt'), 'b');
    execSync('git add -A && git commit -m "task-b"', { cwd: tmpDir });
    const hashB = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // C from A
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-c', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'c.txt'), 'c');
    execSync('git add -A && git commit -m "task-c"', { cwd: tmpDir });
    const hashC = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // D merges B and C
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-d', { cwd: tmpDir });
    execSync(`git merge -m "Merge upstream task-b" task-b`, { cwd: tmpDir });
    execSync(`git merge -m "Merge upstream task-c" task-c`, { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'd.txt'), 'd');
    execSync('git add -A && git commit -m "task-d"', { cwd: tmpDir });
    const hashD = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // E depends on D
    execSync('git checkout -b task-e', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'e.txt'), 'e');
    execSync('git add -A && git commit -m "task-e"', { cwd: tmpDir });

    // Verify full ancestry chain
    expect(isAncestor(tmpDir, hashA, 'HEAD')).toBe(true);
    expect(isAncestor(tmpDir, hashB, 'HEAD')).toBe(true);
    expect(isAncestor(tmpDir, hashC, 'HEAD')).toBe(true);
    expect(isAncestor(tmpDir, hashD, 'HEAD')).toBe(true);
  });

  it('multiple diamonds in sequence: A→B,C→D→E,F→G', async () => {
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // Diamond 1: A → B, C → D
    execSync('git checkout -b task-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'b.txt'), 'b');
    execSync('git add -A && git commit -m "task-b"', { cwd: tmpDir });

    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-c', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'c.txt'), 'c');
    execSync('git add -A && git commit -m "task-c"', { cwd: tmpDir });

    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-d', { cwd: tmpDir });
    execSync('git merge -m "Merge upstream task-b" task-b', { cwd: tmpDir });
    execSync('git merge -m "Merge upstream task-c" task-c', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'd.txt'), 'd');
    execSync('git add -A && git commit -m "task-d"', { cwd: tmpDir });
    const hashD = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // Diamond 2: D → E, F → G
    execSync('git checkout -b task-e', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'e.txt'), 'e');
    execSync('git add -A && git commit -m "task-e"', { cwd: tmpDir });

    execSync(`git checkout ${hashD}`, { cwd: tmpDir });
    execSync('git checkout -b task-f', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'f.txt'), 'f');
    execSync('git add -A && git commit -m "task-f"', { cwd: tmpDir });

    execSync(`git checkout ${hashD}`, { cwd: tmpDir });
    execSync('git checkout -b task-g', { cwd: tmpDir });
    execSync('git merge -m "Merge upstream task-e" task-e', { cwd: tmpDir });
    execSync('git merge -m "Merge upstream task-f" task-f', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'g.txt'), 'g');
    execSync('git add -A && git commit -m "task-g"', { cwd: tmpDir });

    // A is ancestor of G through entire chain
    expect(isAncestor(tmpDir, hashA, 'HEAD')).toBe(true);
    // G contains all files
    for (const file of ['b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt', 'g.txt']) {
      expect(existsSync(join(tmpDir, file))).toBe(true);
    }
  });

  it('wide fan-in: A→B, A→C, A→D, B+C+D→E', async () => {
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // Create 3 branches from A
    for (const name of ['task-b', 'task-c', 'task-d']) {
      execSync(`git checkout ${hashA}`, { cwd: tmpDir });
      execSync(`git checkout -b ${name}`, { cwd: tmpDir });
      writeFileSync(join(tmpDir, `${name}.txt`), `${name}-work`);
      execSync(`git add -A && git commit -m "${name}"`, { cwd: tmpDir });
    }

    // E: make own commit first (prevent fast-forward), then merge all 3
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-e', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'e-setup.txt'), 'e-setup');
    execSync('git add -A && git commit -m "task-e setup"', { cwd: tmpDir });
    for (const name of ['task-b', 'task-c', 'task-d']) {
      execSync(`git merge -m "Merge upstream ${name}" ${name}`, { cwd: tmpDir });
    }
    writeFileSync(join(tmpDir, 'e.txt'), 'e-work');
    execSync('git add -A && git commit -m "task-e"', { cwd: tmpDir });

    // All ancestors
    for (const name of ['task-b', 'task-c', 'task-d']) {
      const hash = execSync(`git rev-parse ${name}`, { cwd: tmpDir }).toString().trim();
      expect(isAncestor(tmpDir, hash, 'HEAD')).toBe(true);
    }

    // All files present
    for (const name of ['task-b', 'task-c', 'task-d', 'e']) {
      expect(existsSync(join(tmpDir, `${name}.txt`))).toBe(true);
    }

    // Merge log shows all 3 in order (most recent first)
    const mergeLog = execSync('git log --merges --oneline', { cwd: tmpDir }).toString();
    const lines = mergeLog.trim().split('\n');
    expect(lines[0]).toContain('task-d');
    expect(lines[1]).toContain('task-c');
    expect(lines[2]).toContain('task-b');
  });

  it('diamond with reconciliation: only winner branch propagated', async () => {
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // exp-v1 from A
    execSync('git checkout -b exp-v1', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'v1.txt'), 'v1-work');
    execSync('git add -A && git commit -m "exp-v1"', { cwd: tmpDir });
    const hashV1 = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // exp-v2 from A
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b exp-v2', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'v2.txt'), 'v2-work');
    execSync('git add -A && git commit -m "exp-v2"', { cwd: tmpDir });
    const hashV2 = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // Reconciliation selects v1 → downstream merges v1's branch only
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b downstream', { cwd: tmpDir });
    execSync('git merge -m "Merge upstream exp-v1" exp-v1', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'downstream.txt'), 'downstream-work');
    execSync('git add -A && git commit -m "downstream"', { cwd: tmpDir });

    // v1 is ancestor of downstream
    expect(isAncestor(tmpDir, hashV1, 'HEAD')).toBe(true);
    // v2 is NOT ancestor of downstream (loser not propagated)
    expect(isAncestor(tmpDir, hashV2, 'HEAD')).toBe(false);
    // v1's file present, v2's file absent
    expect(existsSync(join(tmpDir, 'v1.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'v2.txt'))).toBe(false);
  });

  it('ancestor check: merging already-included branch is a no-op', async () => {
    // A is the initial commit
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // B branches from A and commits (B includes A by construction)
    execSync('git checkout -b task-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'b.txt'), 'b');
    execSync('git add -A && git commit -m "task-b"', { cwd: tmpDir });

    // C: start from A, make own commit (prevent fast-forward), then merge B
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-c', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'c-setup.txt'), 'c-setup');
    execSync('git add -A && git commit -m "task-c setup"', { cwd: tmpDir });
    execSync('git merge -m "Merge upstream task-b" task-b', { cwd: tmpDir });

    // After merging B, A is already an ancestor of HEAD
    expect(isAncestor(tmpDir, hashA, 'HEAD')).toBe(true);

    // Attempting to merge A again is redundant — our mergeUpstreamBranches skips it.
    // Verify git would produce "Already up to date" (confirming the ancestor check is sound)
    const result = execSync(`git merge ${hashA} 2>&1`, { cwd: tmpDir }).toString().trim();
    expect(result).toContain('Already up to date');

    // Only 1 merge commit exists (from B), not 2
    const mergeCount = execSync('git log --merges --oneline', { cwd: tmpDir })
      .toString().trim().split('\n').filter(l => l).length;
    expect(mergeCount).toBe(1);
  });
});

// ── Merge gate commit topology ─────────────────────────────────

import { TaskExecutor, FamiliarRegistry } from '../index.js';
import type { TaskState } from '@invoker/core';

describe('merge gate commit topology (real git)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTaskState(overrides: Partial<TaskState> & { id: string }): TaskState {
    return {
      description: overrides.id,
      status: 'completed',
      dependencies: [],
      createdAt: new Date(),
      ...overrides,
    } as TaskState;
  }

  function createExecutor(
    tasks: TaskState[],
    workflow: Record<string, unknown>,
  ): TaskExecutor {
    const orchestrator = {
      getTask: (id: string) => tasks.find(t => t.id === id),
      getAllTasks: () => tasks,
      handleWorkerResponse: () => [],
      setTaskAwaitingApproval: () => {},
    };
    const persistence = {
      loadWorkflow: () => workflow,
      updateTask: () => {},
    };
    const registry = new FamiliarRegistry();
    return new TaskExecutor({
      orchestrator: orchestrator as any,
      persistence: persistence as any,
      familiarRegistry: registry,
      cwd: tmpDir,
    });
  }

  it('consolidate + approve produces correct merge topology on master', async () => {
    const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // Create task-a branch with a unique file
    execSync('git checkout -b experiment/task-a', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'a.txt'), 'a-work');
    execSync('git add -A && git commit -m "task-a work"', { cwd: tmpDir });
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // Create task-b branch from master with a unique file
    execSync('git checkout master', { cwd: tmpDir });
    execSync('git checkout -b experiment/task-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'b.txt'), 'b-work');
    execSync('git add -A && git commit -m "task-b work"', { cwd: tmpDir });
    const hashB = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // Go back to master for the executor
    execSync('git checkout master', { cwd: tmpDir });

    const tasks: TaskState[] = [
      makeTaskState({ id: 'task-a', workflowId: 'wf-1', status: 'completed', branch: 'experiment/task-a' }),
      makeTaskState({ id: 'task-b', workflowId: 'wf-1', status: 'completed', branch: 'experiment/task-b' }),
      makeTaskState({ id: '__merge__wf-1', workflowId: 'wf-1', status: 'running', isMergeNode: true }),
    ];

    const workflow = {
      id: 'wf-1',
      onFinish: 'merge',
      mergeMode: 'manual',
      baseBranch: 'master',
      featureBranch: 'feat/my-workflow',
      name: 'My Workflow',
    };

    const executor = createExecutor(tasks, workflow);

    // Phase 1: consolidation (manual mode — effectiveOnFinish='none')
    const mergeTask = tasks.find(t => t.isMergeNode)!;
    await (executor as any).executeMergeNode(mergeTask);

    // Feature branch should exist and contain both task branches
    const featureTip = execSync('git rev-parse feat/my-workflow', { cwd: tmpDir }).toString().trim();
    expect(isAncestor(tmpDir, hashA, featureTip)).toBe(true);
    expect(isAncestor(tmpDir, hashB, featureTip)).toBe(true);

    // Master should NOT have moved (no final merge yet)
    const masterAfterConsolidate = execSync('git rev-parse master', { cwd: tmpDir }).toString().trim();
    expect(masterAfterConsolidate).toBe(masterHead);

    // Feature branch should have 2 merge commits (one per task branch)
    const featureMerges = execSync('git log --merges --oneline feat/my-workflow', { cwd: tmpDir })
      .toString().trim().split('\n').filter(l => l);
    expect(featureMerges.length).toBe(2);

    // Phase 2: approve — final merge into master
    await executor.approveMerge('wf-1');

    // Master should now have the feature branch merged
    const masterFinal = execSync('git rev-parse master', { cwd: tmpDir }).toString().trim();
    expect(masterFinal).not.toBe(masterHead);

    // All task commits reachable from master
    expect(isAncestor(tmpDir, hashA, 'master')).toBe(true);
    expect(isAncestor(tmpDir, hashB, 'master')).toBe(true);

    // All files present on master
    expect(existsSync(join(tmpDir, 'a.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'b.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'initial.txt'))).toBe(true);

    // Exactly 1 merge commit on master (the no-ff merge of feat/my-workflow)
    const masterMerges = execSync('git log --merges --oneline master', { cwd: tmpDir })
      .toString().trim().split('\n').filter(l => l);
    // 2 from feature branch consolidation + 1 from final merge = 3 total on master
    // But only 1 is directly on master (the no-ff merge of the feature branch)
    const masterOnlyMerges = execSync(
      'git log --merges --first-parent --oneline master',
      { cwd: tmpDir },
    ).toString().trim().split('\n').filter(l => l);
    expect(masterOnlyMerges.length).toBe(1);
    expect(masterOnlyMerges[0]).toContain('My Workflow');
  });

  it('automatic mode produces same topology in a single step', async () => {
    const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // Create task branches
    execSync('git checkout -b experiment/task-a', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'a.txt'), 'a-work');
    execSync('git add -A && git commit -m "task-a work"', { cwd: tmpDir });
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync('git checkout master', { cwd: tmpDir });
    execSync('git checkout -b experiment/task-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'b.txt'), 'b-work');
    execSync('git add -A && git commit -m "task-b work"', { cwd: tmpDir });
    const hashB = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync('git checkout master', { cwd: tmpDir });

    const tasks: TaskState[] = [
      makeTaskState({ id: 'task-a', workflowId: 'wf-1', status: 'completed', branch: 'experiment/task-a' }),
      makeTaskState({ id: 'task-b', workflowId: 'wf-1', status: 'completed', branch: 'experiment/task-b' }),
      makeTaskState({ id: '__merge__wf-1', workflowId: 'wf-1', status: 'running', isMergeNode: true }),
    ];

    const workflow = {
      id: 'wf-1',
      onFinish: 'merge',
      mergeMode: 'automatic',
      baseBranch: 'master',
      featureBranch: 'feat/auto-workflow',
      name: 'Auto Workflow',
    };

    const executor = createExecutor(tasks, workflow);
    const mergeTask = tasks.find(t => t.isMergeNode)!;
    await (executor as any).executeMergeNode(mergeTask);

    // Master should have moved (full merge in one step)
    const masterFinal = execSync('git rev-parse master', { cwd: tmpDir }).toString().trim();
    expect(masterFinal).not.toBe(masterHead);

    // All task commits reachable from master
    expect(isAncestor(tmpDir, hashA, 'master')).toBe(true);
    expect(isAncestor(tmpDir, hashB, 'master')).toBe(true);

    // All files present
    expect(existsSync(join(tmpDir, 'a.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'b.txt'))).toBe(true);

    // 1 first-parent merge on master (the no-ff merge of the feature branch)
    const masterOnlyMerges = execSync(
      'git log --merges --first-parent --oneline master',
      { cwd: tmpDir },
    ).toString().trim().split('\n').filter(l => l);
    expect(masterOnlyMerges.length).toBe(1);
    expect(masterOnlyMerges[0]).toContain('Auto Workflow');
  });
});
