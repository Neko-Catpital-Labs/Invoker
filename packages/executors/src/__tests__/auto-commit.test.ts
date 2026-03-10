import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  async testAutoCommit(cwd: string, actionId: string): Promise<string | null> {
    return this.autoCommit(cwd, actionId);
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
