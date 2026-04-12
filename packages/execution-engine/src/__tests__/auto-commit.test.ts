import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { BaseExecutor, type BaseEntry, MergeConflictError, type SetupBranchOptions } from '../base-executor.js';
import type { WorkRequest, WorkRequestInputs, WorkResponse } from '@invoker/contracts';
import type { ExecutorHandle, TerminalSpec } from '../executor.js';

function makeRequest(actionId: string, inputs: Partial<WorkRequestInputs> = {}): WorkRequest {
  return {
    requestId: 'test-req',
    actionId,
    actionType: inputs.prompt ? 'ai_task' : 'command',
    inputs: { ...inputs },
    callbackUrl: '',
    timestamps: { createdAt: new Date().toISOString() },
  };
}

// Concrete implementation for testing
class TestExecutor extends BaseExecutor<BaseEntry> {
  readonly type = 'test';

  async start(_request: WorkRequest): Promise<ExecutorHandle> {
    throw new Error('Not implemented');
  }
  async kill(_handle: ExecutorHandle): Promise<void> {}
  sendInput(_handle: ExecutorHandle, _input: string): void {}
  getTerminalSpec(_handle: ExecutorHandle): TerminalSpec | null { return null; }
  getRestoredTerminalSpec(): TerminalSpec { throw new Error('Not implemented'); }
  async destroyAll(): Promise<void> { this.entries.clear(); }

  async testAutoCommit(cwd: string, request: WorkRequest): Promise<string | null> {
    return this.autoCommit(cwd, request);
  }

  async testEnsureFeatureBranch(cwd: string, branchName: string): Promise<void> {
    return this.ensureFeatureBranch(cwd, branchName);
  }

  async testSetupTaskBranch(cwd: string, request: WorkRequest, handle: ExecutorHandle, opts?: SetupBranchOptions): Promise<string | undefined> {
    return this.setupTaskBranch(cwd, request, handle, opts);
  }

  async testRecordTaskResult(cwd: string, request: WorkRequest, exitCode: number): Promise<string | null> {
    return this.recordTaskResult(cwd, request, exitCode);
  }

  async testRestoreBranch(cwd: string, originalBranch: string | undefined): Promise<void> {
    return this.restoreBranch(cwd, originalBranch);
  }

  async testSyncFromRemote(cwd: string, executionId?: string): Promise<void> {
    return this.syncFromRemote(cwd, executionId);
  }

  async testPushBranchToRemote(cwd: string, branch: string, executionId?: string): Promise<string | undefined> {
    return this.pushBranchToRemote(cwd, branch, executionId);
  }

  async testHandleProcessExit(
    executionId: string,
    request: WorkRequest,
    cwd: string,
    exitCode: number,
    opts?: { branch?: string; originalBranch?: string },
  ): Promise<void> {
    return this.handleProcessExit(executionId, request, cwd, exitCode, opts);
  }

  testBuildCommandAndArgs(request: WorkRequest, claudeCommand?: string) {
    return this.buildCommandAndArgs(request, claudeCommand ? { claudeCommand } : undefined);
  }

  testScheduleReconciliationResponse(executionId: string) {
    return this.scheduleReconciliationResponse(executionId);
  }

  registerTestEntry(executionId: string, request: WorkRequest) {
    const entry: BaseEntry = {
      request,
      outputListeners: new Set(),
      outputBuffer: [],
      outputBufferBytes: 0,
      evictedChunkCount: 0,
      completeListeners: new Set(),
      heartbeatListeners: new Set(),
      completed: false,
    };
    this.entries.set(executionId, entry);
    return entry;
  }
}

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'auto-commit-test-'));
  execSync('git init -b master', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, 'initial.txt'), 'initial content');
  execSync('git add -A && git commit -m "initial"', { cwd: dir });
  return dir;
}

describe('BaseExecutor.autoCommit', () => {
  let executor: TestExecutor;
  let tmpDir: string;

  beforeEach(() => {
    executor = new TestExecutor();
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('commits changes and returns hash', async () => {
    writeFileSync(join(tmpDir, 'new-file.txt'), 'new content');
    const hash = await executor.testAutoCommit(tmpDir, makeRequest('test-action'));

    expect(hash).toBeDefined();
    expect(hash).not.toBeNull();
    expect(hash!.length).toBeGreaterThan(0);

    const log = execSync('git log -1 --pretty=%s', { cwd: tmpDir }).toString().trim();
    expect(log).toBe('invoker: test-action');
  });

  it('returns null when no changes', async () => {
    const hash = await executor.testAutoCommit(tmpDir, makeRequest('test-action'));
    expect(hash).toBeNull();
  });

  it('returns null for non-git directories', async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'non-git-'));
    const hash = await executor.testAutoCommit(nonGitDir, makeRequest('test-action'));
    expect(hash).toBeNull();
    rmSync(nonGitDir, { recursive: true, force: true });
  });
});

describe('BaseExecutor.ensureFeatureBranch', () => {
  let executor: TestExecutor;
  let tmpDir: string;

  beforeEach(() => {
    executor = new TestExecutor();
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a feature branch from current HEAD', async () => {
    await executor.testEnsureFeatureBranch(tmpDir, 'task/step-1');

    const branch = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(branch).toBe('task/step-1');
  });

  it('checks out existing branch without error', async () => {
    await executor.testEnsureFeatureBranch(tmpDir, 'task/step-1');
    // Switch away
    execSync('git checkout -b other', { cwd: tmpDir });
    // Switch back to existing branch
    await executor.testEnsureFeatureBranch(tmpDir, 'task/step-1');

    const branch = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(branch).toBe('task/step-1');
  });

  it('creates chained branches: step2 branches off step1', async () => {
    // Create step1 branch and commit
    await executor.testEnsureFeatureBranch(tmpDir, 'task/step-1');
    writeFileSync(join(tmpDir, 'step1.txt'), 'step1');
    await executor.testAutoCommit(tmpDir, makeRequest('step-1'));

    // Create step2 branch (from current HEAD = task/step-1)
    await executor.testEnsureFeatureBranch(tmpDir, 'task/step-2');
    writeFileSync(join(tmpDir, 'step2.txt'), 'step2');
    await executor.testAutoCommit(tmpDir, makeRequest('step-2'));

    const branch = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(branch).toBe('task/step-2');

    // Verify ancestry: step1 commit is an ancestor of step2
    const step1Hash = execSync('git rev-parse task/step-1', { cwd: tmpDir }).toString().trim();
    execSync(`git merge-base --is-ancestor ${step1Hash} HEAD`, { cwd: tmpDir });
    // If the above didn't throw, step1 is ancestor of step2
  });

  it('three-task chain has correct branch parentage', async () => {
    for (const step of ['step-1', 'step-2', 'step-3']) {
      await executor.testEnsureFeatureBranch(tmpDir, `task/${step}`);
      writeFileSync(join(tmpDir, `${step}.txt`), step);
      await executor.testAutoCommit(tmpDir, makeRequest(step));
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
    await executor.testEnsureFeatureBranch(nonGitDir, 'task/test');
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
  let executor: TestExecutor;
  let tmpDir: string;

  beforeEach(() => {
    executor = new TestExecutor();
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes description in commit headline', async () => {
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    await executor.testAutoCommit(tmpDir, makeRequest('task-1', {
      description: 'Implement auth middleware',
    }));

    const subject = getCommitSubject(tmpDir);
    expect(subject).toBe('invoker: task-1 — Implement auth middleware');
  });

  it('includes Context section with upstream DAG deps and hashes', async () => {
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    await executor.testAutoCommit(tmpDir, makeRequest('task-2', {
      upstreamContext: [
        { taskId: 'task-1', description: 'Setup database', commitHash: 'abc1234567890' },
      ],
    }));

    const body = getCommitBody(tmpDir);
    expect(body).toContain('Context:');
    expect(body).toContain('task-1 (abc1234): Setup database');
  });

  it('includes Context section without hash when commitHash missing', async () => {
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    await executor.testAutoCommit(tmpDir, makeRequest('task-2', {
      upstreamContext: [
        { taskId: 'task-1', description: 'Setup database' },
      ],
    }));

    const body = getCommitBody(tmpDir);
    expect(body).toContain('Context:');
    expect(body).toContain('task-1: Setup database');
  });

  it('includes Alternatives Considered section with experiment data', async () => {
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    await executor.testAutoCommit(tmpDir, makeRequest('task-3', {
      description: 'Implement auth',
      prompt: 'Add auth middleware',
      alternatives: [
        {
          taskId: 'exp-v1',
          description: 'JWT approach',
          branch: 'experiment/exp-v1-a1b2c3d4',
          commitHash: 'abc1234567890',
          status: 'completed',
          summary: 'Used JWT tokens',
          selected: true,
        },
        {
          taskId: 'exp-v2',
          description: 'OAuth2 approach',
          branch: 'experiment/exp-v2-e5f6g7h8',
          commitHash: 'fed9876543210',
          status: 'failed',
          exitCode: 1,
          summary: 'Tried OAuth2 flow',
          selected: false,
        },
      ],
    }));

    const body = getCommitBody(tmpDir);
    expect(body).toContain('Alternatives Considered:');
    expect(body).toContain('exp-v1 abc1234');
    expect(body).toContain('experiment/exp-v1-a1b2c3d4, completed');
    expect(body).toContain('Used JWT tokens');
    expect(body).toContain('[selected]');
    expect(body).toContain('exp-v2 fed9876');
    expect(body).toContain('failed, exit 1');
    expect(body).toContain('Tried OAuth2 flow');
  });

  it('includes Solution section from description', async () => {
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    await executor.testAutoCommit(tmpDir, makeRequest('task-1', {
      description: 'Implement auth middleware',
      prompt: 'Add auth',
    }));

    const body = getCommitBody(tmpDir);
    expect(body).toContain('Solution:');
    expect(body).toContain('Implement auth middleware');
  });

  it('omits sections when data is empty', async () => {
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    await executor.testAutoCommit(tmpDir, makeRequest('task-1'));

    const body = getCommitBody(tmpDir);
    expect(body).toBe('invoker: task-1');
    expect(body).not.toContain('Context:');
    expect(body).not.toContain('Alternatives Considered:');
    expect(body).not.toContain('Solution:');
  });

  it('all three sections appear in correct order', async () => {
    writeFileSync(join(tmpDir, 'file.txt'), 'content');
    await executor.testAutoCommit(tmpDir, makeRequest('task-5', {
      description: 'Add login page',
      prompt: 'Create login page',
      upstreamContext: [
        { taskId: 'task-1', description: 'Setup project', commitHash: 'aaa1111111111' },
        { taskId: 'task-2', description: 'Add database', commitHash: 'bbb2222222222' },
      ],
      alternatives: [
        { taskId: 'exp-v1', description: 'Approach A', commitHash: 'ccc3333333333', branch: 'experiment/exp-v1', status: 'completed', selected: true },
      ],
    }));

    const body = getCommitBody(tmpDir);
    const contextIdx = body.indexOf('Context:');
    const altIdx = body.indexOf('Alternatives Considered:');
    const solIdx = body.indexOf('Solution:');

    expect(contextIdx).toBeGreaterThan(-1);
    expect(altIdx).toBeGreaterThan(contextIdx);
    expect(solIdx).toBeGreaterThan(altIdx);
  });
});

// ── B. Commit context propagation ───────────────────────────

describe('commit context propagation', () => {
  let executor: TestExecutor;
  let tmpDir: string;

  beforeEach(() => {
    executor = new TestExecutor();
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('downstream task reads upstream commit message in context', async () => {
    // Task A commits
    writeFileSync(join(tmpDir, 'a.txt'), 'task-a work');
    await executor.testAutoCommit(tmpDir, makeRequest('task-a', {
      description: 'Implement auth',
    }));
    const commitA = getCommitBody(tmpDir);

    // Task B uses A's commit message as upstream context
    writeFileSync(join(tmpDir, 'b.txt'), 'task-b work');
    await executor.testAutoCommit(tmpDir, makeRequest('task-b', {
      description: 'Add login page',
      upstreamContext: [
        { taskId: 'task-a', description: 'Implement auth', commitMessage: commitA },
      ],
    }));

    const commitB = getCommitBody(tmpDir);
    expect(commitB).toContain('Context:');
    expect(commitB).toContain('task-a: Implement auth');
  });

  it('fan-out: two downstream tasks both read same upstream commit', async () => {
    // Task A commits
    writeFileSync(join(tmpDir, 'a.txt'), 'task-a work');
    await executor.testAutoCommit(tmpDir, makeRequest('task-a', {
      description: 'Shared setup',
    }));
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
    const commitA = getCommitBody(tmpDir);

    // Task B branches from A
    execSync('git checkout -b task-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'b.txt'), 'task-b work');
    await executor.testAutoCommit(tmpDir, makeRequest('task-b', {
      description: 'Feature B',
      upstreamContext: [
        { taskId: 'task-a', description: 'Shared setup', commitMessage: commitA },
      ],
    }));

    // Task C branches from A
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-c', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'c.txt'), 'task-c work');
    await executor.testAutoCommit(tmpDir, makeRequest('task-c', {
      description: 'Feature C',
      upstreamContext: [
        { taskId: 'task-a', description: 'Shared setup', commitMessage: commitA },
      ],
    }));

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
    await executor.testAutoCommit(tmpDir, makeRequest('task-a', { description: 'Step A' }));
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
    const commitA = getCommitBody(tmpDir);

    // Task B
    writeFileSync(join(tmpDir, 'b.txt'), 'b');
    await executor.testAutoCommit(tmpDir, makeRequest('task-b', {
      description: 'Step B',
      upstreamContext: [
        { taskId: 'task-a', description: 'Step A', commitMessage: commitA },
      ],
    }));
    const hashB = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
    const commitB = getCommitBody(tmpDir);

    // Task C with both A and B in upstream context
    writeFileSync(join(tmpDir, 'c.txt'), 'c');
    await executor.testAutoCommit(tmpDir, makeRequest('task-c', {
      description: 'Step C',
      upstreamContext: [
        { taskId: 'task-a', description: 'Step A', commitMessage: commitA },
        { taskId: 'task-b', description: 'Step B', commitMessage: commitB },
      ],
    }));

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
  let executor: TestExecutor;
  let tmpDir: string;

  beforeEach(() => {
    executor = new TestExecutor();
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
    await executor.testAutoCommit(tmpDir, makeRequest('task-b', { description: 'Feature B' }));
    const hashB = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // C: branch from A with unique file
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-c', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'c.txt'), 'c-work');
    await executor.testAutoCommit(tmpDir, makeRequest('task-c', { description: 'Feature C' }));
    const hashC = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // D: merge B then C (simulating worktree merge strategy)
    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-d', { cwd: tmpDir });
    execSync(`git merge -m "Merge upstream task-b" task-b`, { cwd: tmpDir });
    execSync(`git merge -m "Merge upstream task-c" task-c`, { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'd.txt'), 'd-work');
    await executor.testAutoCommit(tmpDir, makeRequest('task-d', {
      description: 'Combine B and C',
      upstreamContext: [
        { taskId: 'task-b', description: 'Feature B', commitMessage: getCommitBody(tmpDir, hashB) },
        { taskId: 'task-c', description: 'Feature C', commitMessage: getCommitBody(tmpDir, hashC) },
      ],
    }));

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
    await executor.testAutoCommit(tmpDir, makeRequest('task-b', { description: 'Implement B' }));
    const hashB = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-c', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'c.txt'), 'c');
    await executor.testAutoCommit(tmpDir, makeRequest('task-c', { description: 'Implement C' }));
    const hashC = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync(`git checkout ${hashA}`, { cwd: tmpDir });
    execSync('git checkout -b task-d', { cwd: tmpDir });
    execSync(`git merge -m "Merge upstream task-b" task-b`, { cwd: tmpDir });
    execSync(`git merge -m "Merge upstream task-c" task-c`, { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'd.txt'), 'd');
    await executor.testAutoCommit(tmpDir, makeRequest('task-d', {
      description: 'Combine results',
      upstreamContext: [
        { taskId: 'task-b', description: 'Implement B', commitMessage: getCommitBody(tmpDir, hashB) },
        { taskId: 'task-c', description: 'Implement C', commitMessage: getCommitBody(tmpDir, hashC) },
      ],
    }));

    const body = getCommitBody(tmpDir);
    expect(body).toContain('task-b: Implement B');
    expect(body).toContain('task-c: Implement C');
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

import { TaskRunner, ExecutorRegistry } from '../index.js';
import { WorktreeExecutor } from '../worktree-executor.js';
import { Orchestrator, type TaskState, type TaskStateChanges, type PlanDefinition, type OrchestratorPersistence, type OrchestratorMessageBus } from '@invoker/workflow-core';

class TestPersistence implements OrchestratorPersistence {
  workflows = new Map<string, any>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();

  saveWorkflow(wf: any): void {
    this.workflows.set(wf.id, { ...wf, createdAt: wf.createdAt ?? new Date().toISOString(), updatedAt: wf.updatedAt ?? new Date().toISOString() });
  }
  updateWorkflow(id: string, changes: any): void {
    const wf = this.workflows.get(id);
    if (wf) Object.assign(wf, changes);
  }
  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }
  updateTask(taskId: string, changes: TaskStateChanges): void {
    const entry = this.tasks.get(taskId);
    if (entry) {
      entry.task = {
        ...entry.task,
        ...(changes.status !== undefined ? { status: changes.status } : {}),
        ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
        config: { ...entry.task.config, ...changes.config },
        execution: { ...entry.task.execution, ...changes.execution },
      } as TaskState;
    }
  }
  listWorkflows() { return Array.from(this.workflows.values()); }
  loadTasks(wfId: string) { return Array.from(this.tasks.values()).filter(e => e.workflowId === wfId).map(e => e.task); }
  loadWorkflow(id: string) { return this.workflows.get(id) as any; }
  getWorkspacePath(taskId: string) {
    const entry = this.tasks.get(taskId);
    return entry?.task.execution.workspacePath ?? null;
  }
  logEvent(): void {}
  saveAttempt(): void {}
  loadAttempts(): any[] { return []; }
  loadAttempt(): undefined { return undefined; }
  updateAttempt(): void {}
}

class TestBus implements OrchestratorMessageBus {
  publish(): void {}
}

describe('merge gate commit topology (real git)', () => {
  let tmpDir: string;
  let bareDir: string;

  beforeEach(() => {
    tmpDir = createTempRepo();
    bareDir = mkdtempSync(join(tmpdir(), 'auto-commit-bare-'));
    rmSync(bareDir, { recursive: true });
    execSync(`git clone --bare . "${bareDir}"`, { cwd: tmpDir });
    execSync(`git remote add origin "${bareDir}"`, { cwd: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(bareDir, { recursive: true, force: true });
  });

  function makeTaskState(overrides: {
    id: string;
    description?: string;
    status?: string;
    dependencies?: string[];
    createdAt?: Date;
    config?: Partial<TaskState['config']>;
    execution?: Partial<TaskState['execution']>;
  }): TaskState {
    return {
      id: overrides.id,
      description: overrides.description ?? overrides.id,
      status: overrides.status ?? 'completed',
      dependencies: overrides.dependencies ?? [],
      createdAt: overrides.createdAt ?? new Date(),
      config: { ...overrides.config },
      execution: { ...overrides.execution },
    } as TaskState;
  }

  function createExecutor(
    tasks: TaskState[],
    workflow: Record<string, unknown>,
  ): TaskRunner {
    const orchestrator = {
      getTask: (id: string) => tasks.find(t => t.id === id),
      getAllTasks: () => tasks,
      handleWorkerResponse: () => [],
      setTaskAwaitingApproval: () => {},
    };
    const persistence = {
      loadWorkflow: () => workflow,
      updateTask: () => {},
      getWorkspacePath: () => null,
    };
    const registry = new ExecutorRegistry();
    return new TaskRunner({
      orchestrator: orchestrator as any,
      persistence: persistence as any,
      executorRegistry: registry,
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
      makeTaskState({ id: 'task-a', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/task-a' } }),
      makeTaskState({ id: 'task-b', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/task-b' } }),
      makeTaskState({ id: '__merge__wf-1', dependencies: ['task-a', 'task-b'], config: { workflowId: 'wf-1', isMergeNode: true }, status: 'running' }),
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
    const mergeTask = tasks.find(t => t.config.isMergeNode)!;
    await (executor as any).executeMergeNode(mergeTask);

    // Master should NOT have moved (no final merge yet)
    const masterAfterConsolidate = execSync('git rev-parse master', { cwd: tmpDir }).toString().trim();
    expect(masterAfterConsolidate).toBe(masterHead);

    // Feature branch is ephemeral (created in a merge clone that's deleted).
    // Recreate it in tmpDir so approveMerge's createMergeWorktree can pick it up.
    execSync('git checkout -b feat/my-workflow master', { cwd: tmpDir });
    execSync('git merge --no-ff experiment/task-a -m "Merge experiment/task-a"', { cwd: tmpDir });
    execSync('git merge --no-ff experiment/task-b -m "Merge experiment/task-b"', { cwd: tmpDir });
    execSync('git checkout master', { cwd: tmpDir });

    // Phase 2: approve — final squash merge into master
    await executor.approveMerge('wf-1');

    // Approve pushes squash commit to origin (bare repo); sync tmpDir
    execSync('git fetch origin', { cwd: tmpDir });
    execSync('git reset --hard origin/master', { cwd: tmpDir });

    // Master should now have the squash-merged changes
    const masterFinal = execSync('git rev-parse master', { cwd: tmpDir }).toString().trim();
    expect(masterFinal).not.toBe(masterHead);

    // All files present on master
    expect(existsSync(join(tmpDir, 'a.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'b.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'initial.txt'))).toBe(true);

    // Squash merge: no merge commits on master's first-parent log
    const masterOnlyMerges = execSync(
      'git log --merges --first-parent --oneline master',
      { cwd: tmpDir },
    ).toString().trim().split('\n').filter(l => l.length > 0);
    expect(masterOnlyMerges.length).toBe(0);

    // Tip commit message should match workflow name
    const tipMsg = execSync('git log -1 --format=%s master', { cwd: tmpDir }).toString().trim();
    expect(tipMsg).toBe('My Workflow');

    // Exactly one new commit on master (squash merge)
    const newCommits = execSync(
      `git log --oneline ${masterHead}..master`,
      { cwd: tmpDir },
    ).toString().trim().split('\n').filter(l => l.length > 0);
    expect(newCommits.length).toBe(1);
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
      makeTaskState({ id: 'task-a', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/task-a' } }),
      makeTaskState({ id: 'task-b', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/task-b' } }),
      makeTaskState({ id: '__merge__wf-1', dependencies: ['task-a', 'task-b'], config: { workflowId: 'wf-1', isMergeNode: true }, status: 'running' }),
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
    const mergeTask = tasks.find(t => t.config.isMergeNode)!;
    await (executor as any).executeMergeNode(mergeTask);

    // Squash commit was pushed to origin; sync tmpDir
    execSync('git fetch origin', { cwd: tmpDir });
    execSync('git reset --hard origin/master', { cwd: tmpDir });

    // Master should have moved (full squash merge in one step)
    const masterFinal = execSync('git rev-parse master', { cwd: tmpDir }).toString().trim();
    expect(masterFinal).not.toBe(masterHead);

    // All files present
    expect(existsSync(join(tmpDir, 'a.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'b.txt'))).toBe(true);

    // Squash merge: no merge commits on master's first-parent log
    const masterOnlyMerges = execSync(
      'git log --merges --first-parent --oneline master',
      { cwd: tmpDir },
    ).toString().trim().split('\n').filter(l => l.length > 0);
    expect(masterOnlyMerges.length).toBe(0);

    // Tip commit message should match workflow name
    const tipMsg = execSync('git log -1 --format=%s master', { cwd: tmpDir }).toString().trim();
    expect(tipMsg).toBe('Auto Workflow');

    // Exactly one new commit on master (squash merge)
    const newCommits = execSync(
      `git log --oneline ${masterHead}..master`,
      { cwd: tmpDir },
    ).toString().trim().split('\n').filter(l => l.length > 0);
    expect(newCommits.length).toBe(1);
  });

  it('rebase handles diverged baseBranch', async () => {
    // Create task branches
    execSync('git checkout -b experiment/task-x', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'x.txt'), 'x-work');
    execSync('git add -A && git commit -m "task-x work"', { cwd: tmpDir });

    execSync('git checkout master', { cwd: tmpDir });

    // Advance master after the task branches were created (diverged base)
    writeFileSync(join(tmpDir, 'diverged.txt'), 'diverged-work');
    execSync('git add -A && git commit -m "diverged master commit"', { cwd: tmpDir });
    execSync('git push origin master', { cwd: tmpDir });
    const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    const tasks: TaskState[] = [
      makeTaskState({ id: 'task-x', config: { workflowId: 'wf-d' }, status: 'completed', execution: { branch: 'experiment/task-x' } }),
      makeTaskState({ id: '__merge__wf-d', dependencies: ['task-x'], config: { workflowId: 'wf-d', isMergeNode: true }, status: 'running' }),
    ];

    const workflow = {
      id: 'wf-d',
      onFinish: 'merge',
      mergeMode: 'automatic',
      baseBranch: 'master',
      featureBranch: 'feat/diverged-workflow',
      name: 'Diverged Workflow',
    };

    const executor = createExecutor(tasks, workflow);
    const mergeTask = tasks.find(t => t.config.isMergeNode)!;
    await (executor as any).executeMergeNode(mergeTask);

    // Squash commit was pushed to origin; sync tmpDir
    execSync('git fetch origin', { cwd: tmpDir });
    execSync('git reset --hard origin/master', { cwd: tmpDir });

    // Master should have moved
    const masterFinal = execSync('git rev-parse master', { cwd: tmpDir }).toString().trim();
    expect(masterFinal).not.toBe(masterHead);

    // Both diverged and task files present
    expect(existsSync(join(tmpDir, 'x.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'diverged.txt'))).toBe(true);

    // Tip commit message should match workflow name
    const tipMsg = execSync('git log -1 --format=%s master', { cwd: tmpDir }).toString().trim();
    expect(tipMsg).toBe('Diverged Workflow');
  });

  it('task branches based on non-master intermediate branch merge correctly', async () => {
    // Build an intermediate branch that contains a resolved merge commit.
    // This models a real workflow where a previous plan's feature branch merged
    // parallel task branches that touched the same file. The rebase approach
    // (removed in this fix) would drop the merge commit and its conflict
    // resolution, replaying the underlying conflicting commits linearly.
    writeFileSync(join(tmpDir, 'config.txt'), 'base\n');
    execSync('git add -A && git commit -m "add config"', { cwd: tmpDir });

    execSync('git checkout -b upstream-a', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'config.txt'), 'base\nupstream-a\n');
    execSync('git add -A && git commit -m "upstream-a"', { cwd: tmpDir });

    execSync('git checkout master', { cwd: tmpDir });
    execSync('git checkout -b upstream-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'config.txt'), 'base\nupstream-b\n');
    execSync('git add -A && git commit -m "upstream-b"', { cwd: tmpDir });

    execSync('git checkout master', { cwd: tmpDir });
    execSync('git checkout -b intermediate', { cwd: tmpDir });
    execSync('git merge --no-ff upstream-a -m "merge upstream-a"', { cwd: tmpDir });
    try { execSync('git merge --no-ff upstream-b -m "merge upstream-b"', { cwd: tmpDir }); } catch { /* conflict expected */ }
    writeFileSync(join(tmpDir, 'config.txt'), 'base\nupstream-a\nupstream-b\n');
    execSync('git add -A && git commit --no-edit', { cwd: tmpDir });

    // Task branches from intermediate, each adding a unique file
    execSync('git checkout -b experiment/task-a', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'a.txt'), 'a-work');
    execSync('git add -A && git commit -m "task-a work"', { cwd: tmpDir });

    execSync('git checkout intermediate', { cwd: tmpDir });
    execSync('git checkout -b experiment/task-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'b.txt'), 'b-work');
    execSync('git add -A && git commit -m "task-b work"', { cwd: tmpDir });

    execSync('git checkout master', { cwd: tmpDir });
    const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    const tasks: TaskState[] = [
      makeTaskState({ id: 'task-a', config: { workflowId: 'wf-i' }, status: 'completed', execution: { branch: 'experiment/task-a' } }),
      makeTaskState({ id: 'task-b', config: { workflowId: 'wf-i' }, status: 'completed', execution: { branch: 'experiment/task-b' } }),
      makeTaskState({ id: '__merge__wf-i', dependencies: ['task-a', 'task-b'], config: { workflowId: 'wf-i', isMergeNode: true }, status: 'running' }),
    ];

    const workflow = {
      id: 'wf-i',
      onFinish: 'merge',
      mergeMode: 'manual',
      baseBranch: 'master',
      featureBranch: 'feat/intermediate-workflow',
      name: 'Intermediate Workflow',
    };

    const executor = createExecutor(tasks, workflow);

    // Phase 1: consolidation (manual mode — effectiveOnFinish='none')
    const mergeTask = tasks.find(t => t.config.isMergeNode)!;
    await (executor as any).executeMergeNode(mergeTask);

    // Master should NOT have moved yet (manual mode)
    const masterAfterConsolidate = execSync('git rev-parse master', { cwd: tmpDir }).toString().trim();
    expect(masterAfterConsolidate).toBe(masterHead);

    // Feature branch is ephemeral (created in a merge clone that's deleted).
    // Recreate it in tmpDir so approveMerge's createMergeWorktree can pick it up.
    execSync('git checkout -b feat/intermediate-workflow master', { cwd: tmpDir });
    execSync('git merge --no-ff experiment/task-a -m "Merge experiment/task-a"', { cwd: tmpDir });
    execSync('git merge --no-ff experiment/task-b -m "Merge experiment/task-b"', { cwd: tmpDir });
    execSync('git checkout master', { cwd: tmpDir });

    // Phase 2: approve — final squash merge into master
    await executor.approveMerge('wf-i');

    // Approve pushes squash commit to origin (bare repo); sync tmpDir
    execSync('git fetch origin', { cwd: tmpDir });
    execSync('git reset --hard origin/master', { cwd: tmpDir });

    // Master should now have the squash-merged changes
    const masterFinal = execSync('git rev-parse master', { cwd: tmpDir }).toString().trim();
    expect(masterFinal).not.toBe(masterHead);

    // All files present on master
    expect(existsSync(join(tmpDir, 'a.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'b.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'config.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'initial.txt'))).toBe(true);

    // Squash merge: no merge commits on master's first-parent log
    const masterOnlyMerges = execSync(
      'git log --merges --first-parent --oneline master',
      { cwd: tmpDir },
    ).toString().trim().split('\n').filter(l => l.length > 0);
    expect(masterOnlyMerges.length).toBe(0);

    const tipMsgI = execSync('git log -1 --format=%s master', { cwd: tmpDir }).toString().trim();
    expect(tipMsgI).toBe('Intermediate Workflow');
  });

  it('orchestrator.approve() with hook triggers real squash merge into master', async () => {
    const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // Create task-a branch with a unique file
    execSync('git checkout -b experiment/task-a', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'a.txt'), 'a-work');
    execSync('git add -A && git commit -m "task-a work"', { cwd: tmpDir });

    // Create task-b branch from master with a unique file
    execSync('git checkout master', { cwd: tmpDir });
    execSync('git checkout -b experiment/task-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'b.txt'), 'b-work');
    execSync('git add -A && git commit -m "task-b work"', { cwd: tmpDir });

    execSync('git checkout master', { cwd: tmpDir });

    // Push task branches to origin so the merge clone can find them
    execSync('git push origin experiment/task-a', { cwd: tmpDir });
    execSync('git push origin experiment/task-b', { cwd: tmpDir });

    // Set up real Orchestrator + TaskRunner with hook wired
    const persistence = new TestPersistence();
    const bus = new TestBus();
    const orchestrator = new Orchestrator({ persistence, messageBus: bus, maxConcurrency: 10 });
    const registry = new ExecutorRegistry();
    const wtExecutor = new WorktreeExecutor({ cacheDir: join(tmpDir, 'cache') });
    registry.register('worktree', wtExecutor);
    const executor = new TaskRunner({
      orchestrator,
      persistence: persistence as any,
      executorRegistry: registry,
      cwd: tmpDir,
      defaultBranch: 'master',
    });

    orchestrator.setBeforeApproveHook(async (task) => {
      if (task.config.isMergeNode && task.config.workflowId) {
        await executor.approveMerge(task.config.workflowId);
      }
    });

    const plan: PlanDefinition = {
      name: 'Hook E2E Plan',
      repoUrl: `file://${bareDir}`,
      onFinish: 'merge',
      mergeMode: 'manual',
      baseBranch: 'master',
      featureBranch: 'feat/hook-e2e',
      tasks: [
        { id: 'task-a', description: 'Task A', command: 'echo a' },
        { id: 'task-b', description: 'Task B', command: 'echo b' },
      ],
    };

    orchestrator.loadPlan(plan);
    orchestrator.startExecution();

    // Simulate task completion with branch info
    const taskA = orchestrator.getTask('task-a')!;
    const taskB = orchestrator.getTask('task-b')!;
    persistence.updateTask('task-a', { execution: { branch: 'experiment/task-a' } });
    persistence.updateTask('task-b', { execution: { branch: 'experiment/task-b' } });
    orchestrator.handleWorkerResponse({ requestId: 'r1', actionId: 'task-a', status: 'completed', outputs: { exitCode: 0 } });
    orchestrator.handleWorkerResponse({ requestId: 'r2', actionId: 'task-b', status: 'completed', outputs: { exitCode: 0 } });

    // Find the merge node and execute it (consolidation phase)
    const mergeNode = orchestrator.getAllTasks().find(t => t.config.isMergeNode)!;
    expect(mergeNode).toBeDefined();
    await executor.executeTasks([orchestrator.getTask(mergeNode.id)!]);

    // After consolidation, merge node should be review_ready (manual mode)
    expect(orchestrator.getTask(mergeNode.id)!.status).toBe('review_ready');

    // Master should NOT have moved yet
    const masterBeforeApprove = execSync('git rev-parse master', { cwd: tmpDir }).toString().trim();
    expect(masterBeforeApprove).toBe(masterHead);

    // The test's persistence.updateTask uses short IDs ('task-a') which don't
    // match the orchestrator's prefixed IDs ('wf-XXXX/task-a'), so consolidation
    // merges 0 task branches. Recreate feat/hook-e2e with the real merges and
    // push to origin so approveMerge's merge worktree picks it up correctly.
    execSync('git checkout -b feat/hook-e2e master', { cwd: tmpDir });
    execSync('git merge --no-ff experiment/task-a -m "Merge experiment/task-a"', { cwd: tmpDir });
    execSync('git merge --no-ff experiment/task-b -m "Merge experiment/task-b"', { cwd: tmpDir });
    execSync('git push --force origin feat/hook-e2e', { cwd: tmpDir });
    execSync('git checkout master', { cwd: tmpDir });

    // Approve via orchestrator — hook should fire and do the squash merge
    await orchestrator.approve(mergeNode.id);

    // State should be completed
    expect(orchestrator.getTask(mergeNode.id)!.status).toBe('completed');

    // Approve pushes squash commit to origin (bare repo); sync tmpDir
    execSync('git fetch origin', { cwd: tmpDir });
    execSync('git checkout master', { cwd: tmpDir });
    execSync('git reset --hard origin/master', { cwd: tmpDir });

    // Master should have moved
    const masterFinal = execSync('git rev-parse master', { cwd: tmpDir }).toString().trim();
    expect(masterFinal).not.toBe(masterHead);

    // All files present on master
    expect(existsSync(join(tmpDir, 'a.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'b.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'initial.txt'))).toBe(true);

    // Squash merge: no merge commits on master's first-parent log
    const masterOnlyMerges = execSync(
      'git log --merges --first-parent --oneline master',
      { cwd: tmpDir },
    ).toString().trim().split('\n').filter(l => l.length > 0);
    expect(masterOnlyMerges.length).toBe(0);

    // Tip commit message should match plan name
    const tipMsg = execSync('git log -1 --format=%s master', { cwd: tmpDir }).toString().trim();
    expect(tipMsg).toBe('Hook E2E Plan');

    // Exactly one new commit on master (squash merge)
    const newCommits = execSync(
      `git log --oneline ${masterHead}..master`,
      { cwd: tmpDir },
    ).toString().trim().split('\n').filter(l => l.length > 0);
    expect(newCommits.length).toBe(1);
  });

});

// ── mergeExperimentBranches (real git) ──────────────────

describe('mergeExperimentBranches (real git)', () => {
  let tmpDir: string;
  let bareDir: string;

  beforeEach(() => {
    tmpDir = createTempRepo();
    bareDir = mkdtempSync(join(tmpdir(), 'auto-commit-bare-'));
    rmSync(bareDir, { recursive: true });
    execSync(`git clone --bare . "${bareDir}"`, { cwd: tmpDir });
    execSync(`git remote add origin "${bareDir}"`, { cwd: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(bareDir, { recursive: true, force: true });
  });

  function makeTaskState(overrides: {
    id: string;
    description?: string;
    status?: string;
    dependencies?: string[];
    createdAt?: Date;
    config?: Partial<TaskState['config']>;
    execution?: Partial<TaskState['execution']>;
  }): TaskState {
    return {
      id: overrides.id,
      description: overrides.description ?? overrides.id,
      status: overrides.status ?? 'completed',
      dependencies: overrides.dependencies ?? [],
      createdAt: overrides.createdAt ?? new Date(),
      config: { ...overrides.config },
      execution: { ...overrides.execution },
    } as TaskState;
  }

  function createMergeExecutor(tasks: TaskState[]): TaskRunner {
    const orchestrator = {
      getTask: (id: string) => tasks.find(t => t.id === id),
      getAllTasks: () => tasks,
    };
    const persistence = {
      loadWorkflow: () => null,
      updateTask: () => {},
    };
    const registry = new ExecutorRegistry();
    return new TaskRunner({
      orchestrator: orchestrator as any,
      persistence: persistence as any,
      executorRegistry: registry,
      cwd: tmpDir,
      defaultBranch: 'master',
    });
  }

  it('merges selected experiment branches into a combined branch with correct topology', async () => {
    // Create 3 experiment branches from master, each with unique files
    for (const name of ['exp-v1', 'exp-v2', 'exp-v3']) {
      execSync(`git checkout -b experiment/${name} master`, { cwd: tmpDir });
      writeFileSync(join(tmpDir, `${name}.txt`), `content from ${name}`);
      execSync(`git add -A && git commit -m "Add ${name}"`, { cwd: tmpDir });
    }
    execSync('git checkout master', { cwd: tmpDir });

    const hashV1 = execSync('git rev-parse experiment/exp-v1', { cwd: tmpDir }).toString().trim();
    const hashV2 = execSync('git rev-parse experiment/exp-v2', { cwd: tmpDir }).toString().trim();
    const hashV3 = execSync('git rev-parse experiment/exp-v3', { cwd: tmpDir }).toString().trim();

    const tasks = [
      makeTaskState({ id: 'pivot', status: 'completed', execution: { branch: 'master' } }),
      makeTaskState({ id: 'pivot-exp-v1', status: 'completed', execution: { branch: 'experiment/exp-v1', commit: hashV1 } }),
      makeTaskState({ id: 'pivot-exp-v2', status: 'completed', execution: { branch: 'experiment/exp-v2', commit: hashV2 } }),
      makeTaskState({ id: 'pivot-exp-v3', status: 'completed', execution: { branch: 'experiment/exp-v3', commit: hashV3 } }),
      makeTaskState({ id: 'pivot-reconciliation', config: { isReconciliation: true, parentTask: 'pivot' }, status: 'needs_input' }),
    ];

    const executor = createMergeExecutor(tasks);

    // Select v1 and v3 (skip v2)
    const result = await executor.mergeExperimentBranches(
      'pivot-reconciliation',
      ['pivot-exp-v1', 'pivot-exp-v3'],
    );

    expect(result.branch).toBe('reconciliation/pivot-reconciliation');
    expect(result.commit).toBeTruthy();

    // Reconciliation branch was pushed to origin; fetch into tmpDir
    execSync('git fetch origin', { cwd: tmpDir });

    // Combined branch should have files from v1 and v3
    execSync(`git checkout -b ${result.branch} origin/${result.branch}`, { cwd: tmpDir });
    expect(existsSync(join(tmpDir, 'exp-v1.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'exp-v3.txt'))).toBe(true);

    // Combined branch should NOT have file from unselected v2
    expect(existsSync(join(tmpDir, 'exp-v2.txt'))).toBe(false);

    // Both selected experiment commits are ancestors
    expect(isAncestor(tmpDir, hashV1, result.branch)).toBe(true);
    expect(isAncestor(tmpDir, hashV3, result.branch)).toBe(true);

    // Merge log shows 2 merge commits
    const merges = execSync(
      `git log --merges --oneline ${result.branch}`,
      { cwd: tmpDir },
    ).toString().trim().split('\n').filter(l => l);
    expect(merges.length).toBe(2);
  });

  it('merge conflict fails cleanly and repo stays in clean state', async () => {
    // Create 2 experiment branches that modify the same file differently
    execSync('git checkout -b experiment/conflict-v1 master', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'shared.txt'), 'version A');
    execSync('git add -A && git commit -m "Add shared v1"', { cwd: tmpDir });

    execSync('git checkout master', { cwd: tmpDir });
    execSync('git checkout -b experiment/conflict-v2 master', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'shared.txt'), 'version B');
    execSync('git add -A && git commit -m "Add shared v2"', { cwd: tmpDir });

    execSync('git checkout master', { cwd: tmpDir });

    const tasks = [
      makeTaskState({ id: 'pivot', status: 'completed', execution: { branch: 'master' } }),
      makeTaskState({ id: 'pivot-exp-cv1', status: 'completed', execution: { branch: 'experiment/conflict-v1' } }),
      makeTaskState({ id: 'pivot-exp-cv2', status: 'completed', execution: { branch: 'experiment/conflict-v2' } }),
      makeTaskState({ id: 'pivot-reconciliation', config: { isReconciliation: true, parentTask: 'pivot' }, status: 'needs_input' }),
    ];

    const executor = createMergeExecutor(tasks);

    await expect(
      executor.mergeExperimentBranches('pivot-reconciliation', ['pivot-exp-cv1', 'pivot-exp-cv2']),
    ).rejects.toThrow();

    // Repo should be in a clean state (on master, no merge in progress)
    const currentBranch = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(currentBranch).toBe('master');

    const status = execSync('git status --porcelain', { cwd: tmpDir }).toString().trim();
    expect(status).toBe('');
  });
});

// ── setupTaskBranch ─────────────────────────────────────────

describe('BaseExecutor.setupTaskBranch', () => {
  let executor: TestExecutor;
  let tmpDir: string;

  beforeEach(() => {
    executor = new TestExecutor();
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates branch from baseBranch when no upstreams', async () => {
    const handle: ExecutorHandle = { executionId: 'e1', taskId: 'task-a' };
    const request = makeRequest('task-a', { baseBranch: 'master' });
    const original = await executor.testSetupTaskBranch(tmpDir, request, handle);

    expect(original).toBe('master');
    expect(handle.branch).toBe('invoker/task-a');

    const branch = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(branch).toBe('invoker/task-a');
  });

  it('creates branch from single upstream (inherits transitive history)', async () => {
    // Create upstream branch with a commit
    execSync('git checkout -b invoker/task-a', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'a.txt'), 'a-work');
    execSync('git add -A && git commit -m "task-a work"', { cwd: tmpDir });
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
    execSync('git checkout master', { cwd: tmpDir });

    const handle: ExecutorHandle = { executionId: 'e2', taskId: 'task-b' };
    const request = makeRequest('task-b', {
      baseBranch: 'master',
      upstreamBranches: ['invoker/task-a'],
    });
    const original = await executor.testSetupTaskBranch(tmpDir, request, handle);

    expect(original).toBe('master');
    expect(handle.branch).toBe('invoker/task-b');

    // task-b branch should be based on task-a
    expect(isAncestor(tmpDir, hashA, 'HEAD')).toBe(true);
    expect(existsSync(join(tmpDir, 'a.txt'))).toBe(true);
  });

  it('merges additional upstream branches (DAG fan-in)', async () => {
    const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // Create two upstream branches from master
    execSync('git checkout -b invoker/task-a', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'a.txt'), 'a-work');
    execSync('git add -A && git commit -m "task-a"', { cwd: tmpDir });
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync(`git checkout ${masterHead}`, { cwd: tmpDir });
    execSync('git checkout -b invoker/task-b', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'b.txt'), 'b-work');
    execSync('git add -A && git commit -m "task-b"', { cwd: tmpDir });
    const hashB = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync('git checkout master', { cwd: tmpDir });

    const handle: ExecutorHandle = { executionId: 'e3', taskId: 'task-c' };
    const request = makeRequest('task-c', {
      baseBranch: 'master',
      upstreamBranches: ['invoker/task-a', 'invoker/task-b'],
    });
    await executor.testSetupTaskBranch(tmpDir, request, handle);

    expect(handle.branch).toBe('invoker/task-c');
    expect(isAncestor(tmpDir, hashA, 'HEAD')).toBe(true);
    expect(isAncestor(tmpDir, hashB, 'HEAD')).toBe(true);
    expect(existsSync(join(tmpDir, 'a.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'b.txt'))).toBe(true);
  });

  it('returns undefined for non-git directories', async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'non-git-'));
    const handle: ExecutorHandle = { executionId: 'e4', taskId: 'task-x' };
    const request = makeRequest('task-x');
    const original = await executor.testSetupTaskBranch(nonGitDir, request, handle);

    expect(original).toBeUndefined();
    expect(handle.branch).toBeUndefined();
    rmSync(nonGitDir, { recursive: true, force: true });
  });

  it('A->B->C chain: each branch carries transitive history', async () => {
    // A: branch from master, commit
    const handleA: ExecutorHandle = { executionId: 'e-a', taskId: 'task-a' };
    await executor.testSetupTaskBranch(tmpDir, makeRequest('task-a', { baseBranch: 'master' }), handleA);
    writeFileSync(join(tmpDir, 'a.txt'), 'a');
    execSync('git add -A && git commit -m "task-a"', { cwd: tmpDir });
    const hashA = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
    await executor.testRestoreBranch(tmpDir, 'master');

    // B: branch from A
    const handleB: ExecutorHandle = { executionId: 'e-b', taskId: 'task-b' };
    await executor.testSetupTaskBranch(tmpDir, makeRequest('task-b', {
      baseBranch: 'master',
      upstreamBranches: ['invoker/task-a'],
    }), handleB);
    writeFileSync(join(tmpDir, 'b.txt'), 'b');
    execSync('git add -A && git commit -m "task-b"', { cwd: tmpDir });
    const hashB = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
    await executor.testRestoreBranch(tmpDir, 'master');

    // C: branch from B
    const handleC: ExecutorHandle = { executionId: 'e-c', taskId: 'task-c' };
    await executor.testSetupTaskBranch(tmpDir, makeRequest('task-c', {
      baseBranch: 'master',
      upstreamBranches: ['invoker/task-b'],
    }), handleC);

    // C should have A's and B's files (transitive)
    expect(existsSync(join(tmpDir, 'a.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'b.txt'))).toBe(true);
    expect(isAncestor(tmpDir, hashA, 'HEAD')).toBe(true);
    expect(isAncestor(tmpDir, hashB, 'HEAD')).toBe(true);
  });

  describe('fan-in merge conflict handling', () => {
    it('local fan-in merge conflict throws instead of silently failing', async () => {
      const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

      execSync('git checkout -b invoker/branch-a', { cwd: tmpDir });
      writeFileSync(join(tmpDir, 'conflict.txt'), 'content from branch A');
      execSync('git add -A && git commit -m "branch A changes"', { cwd: tmpDir });

      execSync(`git checkout ${masterHead}`, { cwd: tmpDir });
      execSync('git checkout -b invoker/branch-b', { cwd: tmpDir });
      writeFileSync(join(tmpDir, 'conflict.txt'), 'content from branch B');
      execSync('git add -A && git commit -m "branch B changes"', { cwd: tmpDir });

      execSync('git checkout master', { cwd: tmpDir });

      const handle: ExecutorHandle = { executionId: 'e-conflict', taskId: 'task-conflict' };
      const request = makeRequest('task-conflict', {
        baseBranch: 'master',
        upstreamBranches: ['invoker/branch-a', 'invoker/branch-b'],
      });

      await expect(executor.testSetupTaskBranch(tmpDir, request, handle))
        .rejects.toThrow('Merge conflict merging');
    });

    it('local fan-in merge conflict runs merge --abort', async () => {
      const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

      execSync('git checkout -b invoker/branch-c', { cwd: tmpDir });
      writeFileSync(join(tmpDir, 'conflict2.txt'), 'content from branch C');
      execSync('git add -A && git commit -m "branch C changes"', { cwd: tmpDir });

      execSync(`git checkout ${masterHead}`, { cwd: tmpDir });
      execSync('git checkout -b invoker/branch-d', { cwd: tmpDir });
      writeFileSync(join(tmpDir, 'conflict2.txt'), 'content from branch D');
      execSync('git add -A && git commit -m "branch D changes"', { cwd: tmpDir });

      execSync('git checkout master', { cwd: tmpDir });

      const handle: ExecutorHandle = { executionId: 'e-conflict2', taskId: 'task-conflict2' };
      const request = makeRequest('task-conflict2', {
        baseBranch: 'master',
        upstreamBranches: ['invoker/branch-c', 'invoker/branch-d'],
      });

      await expect(executor.testSetupTaskBranch(tmpDir, request, handle))
        .rejects.toThrow('Merge conflict merging');

      const status = execSync('git status --porcelain', { cwd: tmpDir }).toString().trim();
      expect(status).toBe('');
    });

    it('diamond conflict recovery: restart one side and re-execute resolves fan-in', async () => {
      const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

      execSync('git checkout -b invoker/branch-b1', { cwd: tmpDir });
      writeFileSync(join(tmpDir, 'shared-recover.txt'), 'content from B1');
      execSync('git add -A && git commit -m "branch B1 changes"', { cwd: tmpDir });

      execSync(`git checkout ${masterHead}`, { cwd: tmpDir });
      execSync('git checkout -b invoker/branch-c1', { cwd: tmpDir });
      writeFileSync(join(tmpDir, 'shared-recover.txt'), 'content from C1');
      execSync('git add -A && git commit -m "branch C1 changes"', { cwd: tmpDir });

      execSync('git checkout master', { cwd: tmpDir });

      const handle: ExecutorHandle = { executionId: 'e-recover', taskId: 'task-recover' };
      const request = makeRequest('task-recover', {
        baseBranch: 'master',
        upstreamBranches: ['invoker/branch-b1', 'invoker/branch-c1'],
      });

      await expect(executor.testSetupTaskBranch(tmpDir, request, handle))
        .rejects.toThrow('Merge conflict merging');

      execSync('git checkout invoker/branch-c1', { cwd: tmpDir });
      execSync('git reset --soft HEAD~1', { cwd: tmpDir });
      execSync('git rm -f shared-recover.txt', { cwd: tmpDir });
      writeFileSync(join(tmpDir, 'c1-only.txt'), 'non-conflicting content');
      execSync('git add c1-only.txt && git commit -m "branch C1 revised"', { cwd: tmpDir });
      execSync('git checkout master', { cwd: tmpDir });

      execSync('git branch -D invoker/task-recover', { cwd: tmpDir });

      const handle2: ExecutorHandle = { executionId: 'e-recover2', taskId: 'task-recover' };
      const original = await executor.testSetupTaskBranch(tmpDir, request, handle2);

      expect(original).toBe('master');
      expect(handle2.branch).toBe('invoker/task-recover');
      expect(existsSync(join(tmpDir, 'shared-recover.txt'))).toBe(true);
      const content = readFileSync(join(tmpDir, 'shared-recover.txt'), 'utf-8');
      expect(content).toBe('content from B1');
      expect(existsSync(join(tmpDir, 'c1-only.txt'))).toBe(true);
    });

    it('diamond conflict at setupTaskBranch surfaces error with merge details', async () => {
      const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

      execSync('git checkout -b invoker/branch-x', { cwd: tmpDir });
      writeFileSync(join(tmpDir, 'shared-detail.txt'), 'content from X');
      execSync('git add -A && git commit -m "branch X changes"', { cwd: tmpDir });

      execSync(`git checkout ${masterHead}`, { cwd: tmpDir });
      execSync('git checkout -b invoker/branch-y', { cwd: tmpDir });
      writeFileSync(join(tmpDir, 'shared-detail.txt'), 'content from Y');
      execSync('git add -A && git commit -m "branch Y changes"', { cwd: tmpDir });

      execSync('git checkout master', { cwd: tmpDir });

      const handle: ExecutorHandle = { executionId: 'e-detail', taskId: 'task-detail' };
      const request = makeRequest('task-detail', {
        baseBranch: 'master',
        upstreamBranches: ['invoker/branch-x', 'invoker/branch-y'],
      });

      await expect(executor.testSetupTaskBranch(tmpDir, request, handle))
        .rejects.toThrow(/invoker\/branch-y/);
    });
  });
});

// ── recordTaskResult ────────────────────────────────────────

describe('BaseExecutor.recordTaskResult', () => {
  let executor: TestExecutor;
  let tmpDir: string;

  beforeEach(() => {
    executor = new TestExecutor();
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('commits file changes via autoCommit', async () => {
    writeFileSync(join(tmpDir, 'new.txt'), 'content');
    const hash = await executor.testRecordTaskResult(tmpDir, makeRequest('task-1', {
      description: 'Add new file',
    }), 0);

    expect(hash).toBeTruthy();
    const subject = getCommitSubject(tmpDir);
    expect(subject).toContain('task-1');
    expect(subject).toContain('Add new file');
  });

  it('creates empty commit when no file changes (command task)', async () => {
    const hash = await executor.testRecordTaskResult(tmpDir, makeRequest('task-1', {
      command: 'pnpm build && pnpm test',
      description: 'Build and test',
    }), 0);

    expect(hash).toBeTruthy();
    const body = getCommitBody(tmpDir);
    expect(body).toContain('task-1');
    expect(body).toContain('Build and test');
    expect(body).toContain('Exit code: 0');
  });

  it('records non-zero exit code in empty commit', async () => {
    const hash = await executor.testRecordTaskResult(tmpDir, makeRequest('task-1', {
      command: 'false',
    }), 1);

    expect(hash).toBeTruthy();
    const body = getCommitBody(tmpDir);
    expect(body).toContain('Exit code: 1');
  });

  it('returns null for non-git directories', async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'non-git-'));
    const hash = await executor.testRecordTaskResult(nonGitDir, makeRequest('task-1'), 0);
    expect(hash).toBeNull();
    rmSync(nonGitDir, { recursive: true, force: true });
  });

  it('prefers autoCommit over empty commit when changes exist', async () => {
    writeFileSync(join(tmpDir, 'file.txt'), 'data');
    await executor.testRecordTaskResult(tmpDir, makeRequest('task-1', {
      description: 'Changed files',
      command: 'do stuff',
    }), 0);

    // Should use buildCommitMessage (from autoCommit), not buildResultCommitMessage
    const body = getCommitBody(tmpDir);
    expect(body).toContain('invoker: task-1');
    expect(body).not.toContain('Exit code:');
  });
});

// ── restoreBranch ───────────────────────────────────────────

describe('BaseExecutor.restoreBranch', () => {
  let executor: TestExecutor;
  let tmpDir: string;

  beforeEach(() => {
    executor = new TestExecutor();
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores original branch', async () => {
    execSync('git checkout -b some-branch', { cwd: tmpDir });
    await executor.testRestoreBranch(tmpDir, 'master');
    const branch = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(branch).toBe('master');
  });

  it('no-op when originalBranch is undefined', async () => {
    const before = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    await executor.testRestoreBranch(tmpDir, undefined);
    const after = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(after).toBe(before);
  });
});

// ── Branch lifecycle integration ────────────────────────

describe('Branch lifecycle: ensureFeatureBranch -> setupTaskBranch -> restoreBranch', () => {
  let executor: TestExecutor;
  let tmpDir: string;

  beforeEach(() => {
    executor = new TestExecutor();
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('restores to the original branch, not the feature branch', async () => {
    const startBranch = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(startBranch).toBe('master');

    await executor.testEnsureFeatureBranch(tmpDir, 'plan/my-feature');
    const afterEnsure = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(afterEnsure).toBe('plan/my-feature');

    const handle = { executionId: 'test-exec', taskId: 'test-task' } as ExecutorHandle;
    const req = makeRequest('test-task', { baseBranch: 'plan/my-feature' });
    const setupOriginal = await executor.testSetupTaskBranch(tmpDir, req, handle);
    expect(setupOriginal).toBe('plan/my-feature');

    const taskBranch = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(taskBranch).toBe('invoker/test-task');

    await executor.testRestoreBranch(tmpDir, startBranch);
    const finalBranch = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(finalBranch).toBe('master');
  });

  it('full lifecycle without featureBranch stays on original branch', async () => {
    const startBranch = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(startBranch).toBe('master');

    const handle = { executionId: 'test-exec', taskId: 'test-task' } as ExecutorHandle;
    const req = makeRequest('test-task');
    const setupOriginal = await executor.testSetupTaskBranch(tmpDir, req, handle);
    expect(setupOriginal).toBe('master');

    await executor.testRestoreBranch(tmpDir, setupOriginal);
    const finalBranch = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
    expect(finalBranch).toBe('master');
  });
});

// ── Sync hooks ──────────────────────────────────────────

describe('BaseExecutor.syncFromRemote', () => {
  let executor: TestExecutor;
  let originDir: string;
  let cloneDir: string;

  beforeEach(() => {
    executor = new TestExecutor();
    // Create a bare origin and a clone
    originDir = mkdtempSync(join(tmpdir(), 'sync-origin-'));
    execSync('git init --bare -b master', { cwd: originDir });
    cloneDir = mkdtempSync(join(tmpdir(), 'sync-clone-'));
    execSync(`git clone ${originDir} .`, { cwd: cloneDir });
    execSync('git config user.email "test@test.com"', { cwd: cloneDir });
    execSync('git config user.name "Test"', { cwd: cloneDir });
    writeFileSync(join(cloneDir, 'file.txt'), 'initial');
    execSync('git add -A && git commit -m "initial"', { cwd: cloneDir });
    execSync('git push origin HEAD', { cwd: cloneDir });
  });

  afterEach(() => {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it('fetches new commits from remote', async () => {
    // Push a second commit via a separate clone so the first clone is behind
    const clone2 = mkdtempSync(join(tmpdir(), 'sync-clone2-'));
    execSync(`git clone ${originDir} .`, { cwd: clone2 });
    execSync('git config user.email "test@test.com"', { cwd: clone2 });
    execSync('git config user.name "Test"', { cwd: clone2 });
    writeFileSync(join(clone2, 'file2.txt'), 'second');
    execSync('git add -A && git commit -m "second" && git push origin HEAD', { cwd: clone2 });
    rmSync(clone2, { recursive: true, force: true });

    // Before sync, cloneDir doesn't know about the new commit
    const beforeCount = execSync('git rev-list --count HEAD', { cwd: cloneDir }).toString().trim();
    expect(beforeCount).toBe('1');

    await executor.testSyncFromRemote(cloneDir);

    // After sync, origin/master has 2 commits
    const afterCount = execSync('git rev-list --count origin/master', { cwd: cloneDir }).toString().trim();
    expect(afterCount).toBe('2');
  });

  it('throws when not in a git repo', async () => {
    const noGit = mkdtempSync(join(tmpdir(), 'sync-nogit-'));
    await expect(executor.testSyncFromRemote(noGit)).rejects.toThrow('Git fetch failed');
    rmSync(noGit, { recursive: true, force: true });
  });

  it('throws when remote is unreachable', async () => {
    // Point origin to a nonexistent path
    execSync('git remote set-url origin /nonexistent/repo', { cwd: cloneDir });
    await expect(executor.testSyncFromRemote(cloneDir)).rejects.toThrow('Git fetch failed');
  });
});

describe('BaseExecutor.pushBranchToRemote', () => {
  let executor: TestExecutor;
  let originDir: string;
  let cloneDir: string;

  beforeEach(() => {
    executor = new TestExecutor();
    originDir = mkdtempSync(join(tmpdir(), 'push-origin-'));
    execSync('git init --bare -b master', { cwd: originDir });
    cloneDir = mkdtempSync(join(tmpdir(), 'push-clone-'));
    execSync(`git clone ${originDir} .`, { cwd: cloneDir });
    execSync('git config user.email "test@test.com"', { cwd: cloneDir });
    execSync('git config user.name "Test"', { cwd: cloneDir });
    writeFileSync(join(cloneDir, 'file.txt'), 'initial');
    execSync('git add -A && git commit -m "initial"', { cwd: cloneDir });
    execSync('git push origin HEAD', { cwd: cloneDir });
  });

  afterEach(() => {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  });

  it('pushes a local branch to the remote', async () => {
    execSync('git checkout -b invoker/task-push', { cwd: cloneDir });
    writeFileSync(join(cloneDir, 'task.txt'), 'task result');
    execSync('git add -A && git commit -m "task commit"', { cwd: cloneDir });

    const pushErr = await executor.testPushBranchToRemote(cloneDir, 'invoker/task-push');
    expect(pushErr).toBeUndefined();

    // Verify the branch exists on the bare remote
    const remoteBranches = execSync('git branch', { cwd: originDir }).toString();
    expect(remoteBranches).toContain('invoker/task-push');
  });

  it('returns an error message when branch does not exist on remote', async () => {
    const err = await executor.testPushBranchToRemote(cloneDir, 'nonexistent-branch');
    expect(err).toBeDefined();
    expect(typeof err).toBe('string');
  });

  it('returns an error message when remote is unreachable', async () => {
    execSync('git checkout -b invoker/task-nopush', { cwd: cloneDir });
    execSync('git remote set-url origin /nonexistent/repo', { cwd: cloneDir });
    const err = await executor.testPushBranchToRemote(cloneDir, 'invoker/task-nopush');
    expect(err).toBeDefined();
    expect(typeof err).toBe('string');
  });
});

describe('BaseExecutor.handleProcessExit push semantics', () => {
  let executor: TestExecutor;
  let originDir: string;
  let cloneDir: string;

  beforeEach(() => {
    executor = new TestExecutor();
    originDir = mkdtempSync(join(tmpdir(), 'hpe-origin-'));
    execSync('git init --bare -b master', { cwd: originDir });
    cloneDir = mkdtempSync(join(tmpdir(), 'hpe-clone-'));
    execSync(`git clone ${originDir} .`, { cwd: cloneDir });
    execSync('git config user.email "test@test.com"', { cwd: cloneDir });
    execSync('git config user.name "Test"', { cwd: cloneDir });
    writeFileSync(join(cloneDir, 'file.txt'), 'initial');
    execSync('git add -A && git commit -m "initial"', { cwd: cloneDir });
    execSync('git push origin HEAD', { cwd: cloneDir });
  });

  afterEach(() => {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('marks task failed when exit 0 but push fails', async () => {
    execSync('git checkout -b invoker/b', { cwd: cloneDir });
    writeFileSync(join(cloneDir, 't.txt'), 'x');
    execSync('git add -A && git commit -m task', { cwd: cloneDir });

    const req = makeRequest('task-1', { description: 'x' });
    const entry = executor.registerTestEntry('e1', req);
    let response: WorkResponse | undefined;
    entry.completeListeners.add((r) => { response = r; });

    vi.spyOn(BaseExecutor.prototype as any, 'pushBranchToRemote').mockResolvedValue('push denied');

    await executor.testHandleProcessExit('e1', req, cloneDir, 0, { branch: 'invoker/b' });

    expect(response?.status).toBe('failed');
    expect(response?.outputs.exitCode).toBe(1);
    expect(response?.outputs.error).toBe('push denied');
  });

  it('marks codex ai_task as failed when semantic sandbox denial appears in output despite exit 0', async () => {
    execSync('git checkout -b invoker/semantic-fail', { cwd: cloneDir });

    const req = makeRequest('task-semantic-fail', {
      description: 'semantic fail',
      prompt: 'Implement the feature',
      executionAgent: 'codex',
    });
    req.actionType = 'ai_task';
    const entry = executor.registerTestEntry('e-semantic', req);
    entry.outputBuffer.push(
      'ERROR codex_core::tools::router: Codex(Sandbox(Denied ... ))\n' +
      'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n',
    );

    let response: WorkResponse | undefined;
    entry.completeListeners.add((r) => { response = r; });

    await executor.testHandleProcessExit('e-semantic', req, cloneDir, 0, { branch: 'invoker/semantic-fail' });

    expect(response?.status).toBe('failed');
    expect(response?.outputs.exitCode).toBe(86);
    expect(response?.outputs.error).toContain('sandbox/tool denial');

    const msg = execSync('git log -1 --format=%B', { cwd: cloneDir }).toString();
    expect(msg).toContain('Exit code: 86');
  });

  it('does not force semantic failure for non-codex agents', async () => {
    execSync('git checkout -b invoker/non-codex', { cwd: cloneDir });

    const req = makeRequest('task-non-codex', {
      description: 'non codex',
      prompt: 'Implement the feature',
      executionAgent: 'claude',
    });
    req.actionType = 'ai_task';
    const entry = executor.registerTestEntry('e-non-codex', req);
    entry.outputBuffer.push(
      'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n',
    );

    let response: WorkResponse | undefined;
    entry.completeListeners.add((r) => { response = r; });

    await executor.testHandleProcessExit('e-non-codex', req, cloneDir, 0, { branch: 'invoker/non-codex' });

    expect(response?.status).toBe('completed');
    expect(response?.outputs.exitCode).toBe(0);
  });
});

// ── buildCommandAndArgs ─────────────────────────────────

describe('BaseExecutor.buildCommandAndArgs', () => {
  let executor: TestExecutor;

  beforeEach(() => {
    executor = new TestExecutor();
  });

  it('returns shell command for actionType=command', () => {
    const req = makeRequest('act', { command: 'echo hello' });
    req.actionType = 'command';
    const result = executor.testBuildCommandAndArgs(req);
    expect(result.cmd).toBe('/bin/bash');
    expect(result.args).toEqual(['-c', 'echo hello']);
    expect(result.agentSessionId).toBeUndefined();
  });

  it('throws when actionType=command has no command', () => {
    const req = makeRequest('act', {});
    req.actionType = 'command';
    req.inputs.command = undefined;
    expect(() => executor.testBuildCommandAndArgs(req)).toThrow('must have inputs.command');
  });

  it('returns claude CLI for actionType=ai_task', () => {
    const req = makeRequest('act', { prompt: 'Do something' });
    req.actionType = 'ai_task';
    const result = executor.testBuildCommandAndArgs(req, 'my-claude');
    expect(result.cmd).toBe('my-claude');
    expect(result.agentSessionId).toBeDefined();
    expect(result.args).toContain('--dangerously-skip-permissions');
  });

  it('returns echo stub for unsupported actionType', () => {
    const req = makeRequest('act', {});
    req.actionType = 'reconciliation';
    const result = executor.testBuildCommandAndArgs(req);
    expect(result.cmd).toBe('/bin/bash');
    expect(result.args[1]).toContain('Unsupported');
  });
});

// ── scheduleReconciliationResponse ──────────────────────

describe('BaseExecutor.scheduleReconciliationResponse', () => {
  let executor: TestExecutor;

  beforeEach(() => {
    executor = new TestExecutor();
  });

  it('emits needs_input response asynchronously', async () => {
    const req = makeRequest('recon-task', {});
    const entry = executor.registerTestEntry('exec-1', req);

    let receivedResponse: WorkResponse | undefined;
    entry.completeListeners.add((r) => { receivedResponse = r; });

    executor.testScheduleReconciliationResponse('exec-1');

    // Should not fire synchronously
    expect(receivedResponse).toBeUndefined();

    // Wait for setTimeout(0)
    await new Promise((r) => setTimeout(r, 10));

    expect(receivedResponse).toBeDefined();
    expect(receivedResponse!.status).toBe('needs_input');
    expect(receivedResponse!.actionId).toBe('recon-task');
    expect(entry.completed).toBe(true);
  });
});

// ── N-dependency merge conflict tests ──────────────────────

describe('BaseExecutor.setupTaskBranch n-dependency conflicts', () => {
  let tmpDir: string;
  let executor: TestExecutor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ndep-'));
    execSync('git init -b master && git commit --allow-empty -m "init"', { cwd: tmpDir });
    executor = new TestExecutor();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('3 deps: conflict at position 2 aborts cleanly, error identifies failed branch', async () => {
    const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // B1: modifies file-a.txt
    execSync('git checkout -b branch-b1', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'file-a.txt'), 'content from B1');
    execSync('git add -A && git commit -m "B1"', { cwd: tmpDir });

    // B2: modifies file-b.txt (no conflict with B1)
    execSync(`git checkout ${masterHead}`, { cwd: tmpDir });
    execSync('git checkout -b branch-b2', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'file-b.txt'), 'content from B2');
    execSync('git add -A && git commit -m "B2"', { cwd: tmpDir });

    // B3: modifies file-a.txt differently (conflicts with B1)
    execSync(`git checkout ${masterHead}`, { cwd: tmpDir });
    execSync('git checkout -b branch-b3', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'file-a.txt'), 'DIFFERENT content from B3');
    execSync('git add -A && git commit -m "B3"', { cwd: tmpDir });

    execSync('git checkout master', { cwd: tmpDir });

    const request = makeRequest('ndep-task', {
      upstreamBranches: ['branch-b1', 'branch-b2', 'branch-b3'],
    });
    const handle: ExecutorHandle = { executionId: 'e1', taskId: 'ndep-task' };

    const err = await executor.testSetupTaskBranch(tmpDir, request, handle).catch(e => e);
    expect(err).toBeInstanceOf(MergeConflictError);
    expect((err as MergeConflictError).failedBranch).toBe('branch-b3');
    expect((err as MergeConflictError).conflictFiles).toContain('file-a.txt');
  });

  it('3 deps: conflict at position 1 produces no partial merges', async () => {
    const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync('git checkout -b branch-c1', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'shared.txt'), 'C1 content');
    execSync('git add -A && git commit -m "C1"', { cwd: tmpDir });

    // C2 conflicts with C1 immediately
    execSync(`git checkout ${masterHead}`, { cwd: tmpDir });
    execSync('git checkout -b branch-c2', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'shared.txt'), 'C2 different content');
    execSync('git add -A && git commit -m "C2"', { cwd: tmpDir });

    // C3 would succeed if reached (modifies different file)
    execSync(`git checkout ${masterHead}`, { cwd: tmpDir });
    execSync('git checkout -b branch-c3', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'other.txt'), 'C3 content');
    execSync('git add -A && git commit -m "C3"', { cwd: tmpDir });

    execSync('git checkout master', { cwd: tmpDir });

    const request = makeRequest('ndep-task2', {
      upstreamBranches: ['branch-c1', 'branch-c2', 'branch-c3'],
    });
    const handle: ExecutorHandle = { executionId: 'e2', taskId: 'ndep-task2' };

    const err = await executor.testSetupTaskBranch(tmpDir, request, handle).catch(e => e);
    expect(err).toBeInstanceOf(MergeConflictError);
    expect((err as MergeConflictError).failedBranch).toBe('branch-c2');
  });

  it('n deps: all succeed when no conflicts', async () => {
    const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    for (let i = 1; i <= 4; i++) {
      execSync(`git checkout ${masterHead}`, { cwd: tmpDir });
      execSync(`git checkout -b branch-ok-${i}`, { cwd: tmpDir });
      writeFileSync(join(tmpDir, `file-${i}.txt`), `content ${i}`);
      execSync(`git add -A && git commit -m "OK ${i}"`, { cwd: tmpDir });
    }

    execSync('git checkout master', { cwd: tmpDir });

    const request = makeRequest('ndep-ok', {
      upstreamBranches: ['branch-ok-1', 'branch-ok-2', 'branch-ok-3', 'branch-ok-4'],
    });
    const handle: ExecutorHandle = { executionId: 'e3', taskId: 'ndep-ok' };

    const result = await executor.testSetupTaskBranch(tmpDir, request, handle);
    expect(result).toBe('master');
    expect(handle.branch).toBe('invoker/ndep-ok');

    // All files should exist
    for (let i = 1; i <= 4; i++) {
      expect(existsSync(join(tmpDir, `file-${i}.txt`))).toBe(true);
    }
  });

  it('branch is clean after merge abort (no markers, no staged files)', async () => {
    const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync('git checkout -b branch-clean-1', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'conflict.txt'), 'version A');
    execSync('git add -A && git commit -m "A"', { cwd: tmpDir });

    execSync(`git checkout ${masterHead}`, { cwd: tmpDir });
    execSync('git checkout -b branch-clean-2', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'conflict.txt'), 'version B');
    execSync('git add -A && git commit -m "B"', { cwd: tmpDir });

    execSync('git checkout master', { cwd: tmpDir });

    const request = makeRequest('clean-task', {
      upstreamBranches: ['branch-clean-1', 'branch-clean-2'],
    });
    const handle: ExecutorHandle = { executionId: 'e4', taskId: 'clean-task' };

    await expect(executor.testSetupTaskBranch(tmpDir, request, handle))
      .rejects.toThrow();

    const status = execSync('git status --porcelain', { cwd: tmpDir }).toString().trim();
    expect(status).toBe('');

    const diff = execSync('git diff', { cwd: tmpDir }).toString().trim();
    expect(diff).toBe('');
  });
});

// ── Branch reset tests ──────────────────────────────────────

describe('BaseExecutor.setupTaskBranch branch reset', () => {
  let tmpDir: string;
  let executor: TestExecutor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reset-'));
    execSync('git init -b master && git commit --allow-empty -m "init"', { cwd: tmpDir });
    executor = new TestExecutor();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves existing branch and merges new base on restart', async () => {
    // First run: create branch from master
    const request = makeRequest('reset-task', { baseBranch: 'master' });
    const handle1: ExecutorHandle = { executionId: 'e1', taskId: 'reset-task' };
    await executor.testSetupTaskBranch(tmpDir, request, handle1);

    // Make a commit on the task branch
    writeFileSync(join(tmpDir, 'old-work.txt'), 'stale');
    execSync('git add -A && git commit -m "old work"', { cwd: tmpDir });
    const oldHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // Move master forward
    execSync('git checkout master', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'new-base.txt'), 'new');
    execSync('git add -A && git commit -m "new base"', { cwd: tmpDir });
    const newMasterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    // Second run: same actionId but base has moved
    const handle2: ExecutorHandle = { executionId: 'e2', taskId: 'reset-task' };
    await executor.testSetupTaskBranch(tmpDir, request, handle2);

    const currentHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
    // Should preserve old work and merge new base (creates merge commit)
    expect(currentHead).not.toBe(oldHead); // Not the old commit (merge happened)
    expect(currentHead).not.toBe(newMasterHead); // Not exactly new master (it's a merge commit)

    // Both files should exist after merge
    expect(existsSync(join(tmpDir, 'old-work.txt'))).toBe(true);
    expect(existsSync(join(tmpDir, 'new-base.txt'))).toBe(true);

    // Verify the merge commit has both parents
    const parents = execSync('git rev-list --parents -n 1 HEAD', { cwd: tmpDir }).toString().trim().split(' ');
    expect(parents.length).toBe(3); // commit hash + 2 parents
    expect(parents.slice(1)).toContain(oldHead);
    expect(parents.slice(1)).toContain(newMasterHead);
  });

  it('restart after conflict re-fails with same conflict', async () => {
    const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync('git checkout -b branch-x', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'conflict.txt'), 'X version');
    execSync('git add -A && git commit -m "X"', { cwd: tmpDir });

    execSync(`git checkout ${masterHead}`, { cwd: tmpDir });
    execSync('git checkout -b branch-y', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'conflict.txt'), 'Y version');
    execSync('git add -A && git commit -m "Y"', { cwd: tmpDir });

    execSync('git checkout master', { cwd: tmpDir });

    const request = makeRequest('refail-task', {
      upstreamBranches: ['branch-x', 'branch-y'],
    });

    // First attempt fails
    const handle1: ExecutorHandle = { executionId: 'e1', taskId: 'refail-task' };
    await expect(executor.testSetupTaskBranch(tmpDir, request, handle1))
      .rejects.toBeInstanceOf(MergeConflictError);

    // Second attempt (restart) also fails with same conflict
    execSync('git checkout master', { cwd: tmpDir });
    const handle2: ExecutorHandle = { executionId: 'e2', taskId: 'refail-task' };
    await expect(executor.testSetupTaskBranch(tmpDir, request, handle2))
      .rejects.toBeInstanceOf(MergeConflictError);
  });

  it('merge conflict produces no new commit on the branch', async () => {
    const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync('git checkout -b up-1', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'f.txt'), 'A');
    execSync('git add -A && git commit -m "A"', { cwd: tmpDir });
    const upHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync(`git checkout ${masterHead}`, { cwd: tmpDir });
    execSync('git checkout -b up-2', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'f.txt'), 'B');
    execSync('git add -A && git commit -m "B"', { cwd: tmpDir });

    execSync('git checkout master', { cwd: tmpDir });

    const request = makeRequest('ncommit-task', {
      upstreamBranches: ['up-1', 'up-2'],
    });
    const handle: ExecutorHandle = { executionId: 'e1', taskId: 'ncommit-task' };

    await expect(executor.testSetupTaskBranch(tmpDir, request, handle))
      .rejects.toThrow();

    // The task branch should be at up-1's HEAD (the base), no new commits
    execSync('git checkout invoker/ncommit-task', { cwd: tmpDir });
    const branchHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
    expect(branchHead).toBe(upHead);
  });

  it('recordTaskResult with non-zero exit still commits file changes', async () => {
    execSync('git checkout -b invoker/fail-commit', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'output.txt'), 'partial results');

    const request = makeRequest('fail-task', { description: 'failing task' });
    const hash = await executor.testRecordTaskResult(tmpDir, request, 1);

    expect(hash).toBeDefined();
    expect(hash).not.toBeNull();

    const msg = execSync(`git log -1 --format=%B`, { cwd: tmpDir }).toString();
    expect(msg).toContain('fail-task');
  });

  it('MergeConflictError captures conflicted files', async () => {
    const masterHead = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

    execSync('git checkout -b mc-branch-1', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'fileA.txt'), 'version 1');
    writeFileSync(join(tmpDir, 'fileB.txt'), 'version 1');
    execSync('git add -A && git commit -m "branch 1"', { cwd: tmpDir });

    execSync(`git checkout ${masterHead}`, { cwd: tmpDir });
    execSync('git checkout -b mc-branch-2', { cwd: tmpDir });
    writeFileSync(join(tmpDir, 'fileA.txt'), 'version 2');
    writeFileSync(join(tmpDir, 'fileB.txt'), 'version 2');
    execSync('git add -A && git commit -m "branch 2"', { cwd: tmpDir });

    execSync('git checkout master', { cwd: tmpDir });

    const request = makeRequest('mc-task', {
      upstreamBranches: ['mc-branch-1', 'mc-branch-2'],
    });
    const handle: ExecutorHandle = { executionId: 'e1', taskId: 'mc-task' };

    try {
      await executor.testSetupTaskBranch(tmpDir, request, handle);
      expect.fail('Should have thrown MergeConflictError');
    } catch (err) {
      expect(err).toBeInstanceOf(MergeConflictError);
      const mce = err as MergeConflictError;
      expect(mce.failedBranch).toBe('mc-branch-2');
      expect(mce.conflictFiles).toContain('fileA.txt');
      expect(mce.conflictFiles).toContain('fileB.txt');
      expect(mce.conflictFiles.length).toBe(2);
    }
  });
});

// ── setupTaskBranch worktree mode tests ────────────────────

describe('BaseExecutor.setupTaskBranch worktree mode', () => {
  let tmpDir: string;
  let executor: TestExecutor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wt-setup-'));
    execSync('git init -b master && git commit --allow-empty -m "init"', { cwd: tmpDir });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir });
    execSync('git config user.name "Test"', { cwd: tmpDir });
  });

  afterEach(() => {
    // Clean up worktrees before removing the temp dir
    try { execSync('git worktree prune', { cwd: tmpDir }); } catch { /* */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves branch with commits ahead via worktree add (no -B) + merge', async () => {
    executor = new TestExecutor();
    const branch = 'experiment/wt-preserve';
    const worktreeDir1 = join(tmpDir, 'wt1');
    const worktreeDir2 = join(tmpDir, 'wt2');

    // First run: create the branch in a worktree
    const request = makeRequest('wt-preserve', { baseBranch: 'master' });
    const handle1: ExecutorHandle = { executionId: 'e1', taskId: 'wt-preserve' };
    await executor.testSetupTaskBranch(tmpDir, request, handle1, {
      branchName: branch,
      base: 'master',
      worktreeDir: worktreeDir1,
      skipUpstreams: true,
    });

    // Make a commit on the branch inside the worktree (simulates a fix/cherry-pick)
    writeFileSync(join(worktreeDir1, 'fix.txt'), 'cherry-picked fix');
    execSync('git add -A && git commit -m "cherry-pick fix"', { cwd: worktreeDir1 });

    // Remove the first worktree so the branch ref is free
    execSync(`git worktree remove --force ${worktreeDir1}`, { cwd: tmpDir });

    // Move master forward
    writeFileSync(join(tmpDir, 'new-base.txt'), 'new base content');
    execSync('git add -A && git commit -m "advance master"', { cwd: tmpDir });

    // Second run: setupTaskBranch should preserve the fix and merge new base
    const handle2: ExecutorHandle = { executionId: 'e2', taskId: 'wt-preserve' };
    await executor.testSetupTaskBranch(tmpDir, request, handle2, {
      branchName: branch,
      base: 'master',
      worktreeDir: worktreeDir2,
      skipUpstreams: true,
    });

    // Both the fix and the new base content should be present
    expect(existsSync(join(worktreeDir2, 'fix.txt'))).toBe(true);
    expect(existsSync(join(worktreeDir2, 'new-base.txt'))).toBe(true);

    // Clean up
    execSync(`git worktree remove --force ${worktreeDir2}`, { cwd: tmpDir });
  });

  it('force-creates via worktree add -B when branch has 0 commits ahead', async () => {
    executor = new TestExecutor();
    const branch = 'experiment/wt-clean';
    const worktreeDir1 = join(tmpDir, 'wt1');
    const worktreeDir2 = join(tmpDir, 'wt2');

    // First run: create branch (no extra commits)
    const request = makeRequest('wt-clean', { baseBranch: 'master' });
    const handle1: ExecutorHandle = { executionId: 'e1', taskId: 'wt-clean' };
    await executor.testSetupTaskBranch(tmpDir, request, handle1, {
      branchName: branch,
      base: 'master',
      worktreeDir: worktreeDir1,
      skipUpstreams: true,
    });

    // Remove first worktree
    execSync(`git worktree remove --force ${worktreeDir1}`, { cwd: tmpDir });

    // Move master forward
    writeFileSync(join(tmpDir, 'new.txt'), 'new');
    execSync('git add -A && git commit -m "advance"', { cwd: tmpDir });
    const newMasterHead = execSync('git rev-parse master', { cwd: tmpDir }).toString().trim();

    // Second run: no commits ahead → force-reset
    const handle2: ExecutorHandle = { executionId: 'e2', taskId: 'wt-clean' };
    await executor.testSetupTaskBranch(tmpDir, request, handle2, {
      branchName: branch,
      base: 'master',
      worktreeDir: worktreeDir2,
      skipUpstreams: true,
    });

    const wtHead = execSync('git rev-parse HEAD', { cwd: worktreeDir2 }).toString().trim();
    expect(wtHead).toBe(newMasterHead);

    // Clean up
    execSync(`git worktree remove --force ${worktreeDir2}`, { cwd: tmpDir });
  });

  it('force-creates via worktree add -B when branch does not exist', async () => {
    executor = new TestExecutor();
    const branch = 'experiment/wt-new';
    const worktreeDir = join(tmpDir, 'wt-new');

    const masterHead = execSync('git rev-parse master', { cwd: tmpDir }).toString().trim();

    const request = makeRequest('wt-new', { baseBranch: 'master' });
    const handle: ExecutorHandle = { executionId: 'e1', taskId: 'wt-new' };
    await executor.testSetupTaskBranch(tmpDir, request, handle, {
      branchName: branch,
      base: 'master',
      worktreeDir,
      skipUpstreams: true,
    });

    // Should be at master HEAD
    const wtHead = execSync('git rev-parse HEAD', { cwd: worktreeDir }).toString().trim();
    expect(wtHead).toBe(masterHead);

    // Branch should be the one we asked for
    const currentBranch = execSync('git branch --show-current', { cwd: worktreeDir }).toString().trim();
    expect(currentBranch).toBe(branch);

    // Clean up
    execSync(`git worktree remove --force ${worktreeDir}`, { cwd: tmpDir });
  });

  it('returns undefined (no originalBranch) in worktree mode', async () => {
    executor = new TestExecutor();
    const branch = 'experiment/wt-no-orig';
    const worktreeDir = join(tmpDir, 'wt-no-orig');

    const request = makeRequest('wt-no-orig', { baseBranch: 'master' });
    const handle: ExecutorHandle = { executionId: 'e1', taskId: 'wt-no-orig' };
    const result = await executor.testSetupTaskBranch(tmpDir, request, handle, {
      branchName: branch,
      base: 'master',
      worktreeDir,
      skipUpstreams: true,
    });

    expect(result).toBeUndefined();

    // Clean up
    execSync(`git worktree remove --force ${worktreeDir}`, { cwd: tmpDir });
  });
});
