/**
 * Fetch failure visibility tests.
 *
 * Validates that git fetch failures are properly surfaced to task output
 * and cause the task to fail fast. Fetch failures are always fatal — there
 * is no lenient mode.
 *
 * Also validates staleness warnings when local branch is significantly behind.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { BaseExecutor, type BaseEntry } from '../base-executor.js';
import type { WorkRequest, WorkRequestInputs } from '@invoker/contracts';
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

  async testSyncFromRemote(cwd: string, executionId?: string): Promise<void> {
    return this.syncFromRemote(cwd, executionId);
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

  getOutputBuffer(executionId: string): string[] {
    const entry = this.entries.get(executionId);
    return entry?.outputBuffer ?? [];
  }
}

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fetch-failure-test-'));
  execSync('git init -b master', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, 'initial.txt'), 'initial content');
  execSync('git add -A && git commit -m "initial"', { cwd: dir });
  return dir;
}

/**
 * Create a bare remote repo and push local to it.
 * Returns the path to the bare repo.
 */
function createRemote(localRepo: string): string {
  const remote = mkdtempSync(join(tmpdir(), 'fetch-failure-remote-'));
  execSync('git init --bare', { cwd: remote });
  execSync(`git remote add origin ${remote}`, { cwd: localRepo });
  execSync('git push -u origin master', { cwd: localRepo });
  return remote;
}

describe('syncFromRemote - fetch failure handling', () => {
  describe('fetch failure (strict by default)', () => {
    let executor: TestExecutor;
    let tmpDir: string;

    beforeEach(() => {
      executor = new TestExecutor();
      tmpDir = createTempRepo();
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('throws and aborts when fetch fails', async () => {
      const executionId = 'test-exec-1';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      // Mock execGitSimple to fail on fetch
      const execGitSpy = vi.spyOn(executor as any, 'execGitSimple');
      execGitSpy.mockImplementation(async (...params: unknown[]) => {
        const args = params[0] as string[];
        if (args[0] === 'fetch') {
          throw new Error('Connection timed out');
        }
        // For other git commands, call through to real git
        return execSync(`git ${args.join(' ')}`, { cwd: tmpDir, encoding: 'utf8' });
      });

      await expect(executor.testSyncFromRemote(tmpDir, executionId))
        .rejects.toThrow('Git fetch failed: Connection timed out');

      // Verify failure was emitted to task output before throwing
      const output = executor.getOutputBuffer(executionId).join('');
      expect(output).toContain('[Git Fetch] Status: FAILED');
      expect(output).toContain('Connection timed out');
      expect(output).toContain('Aborting task');
    });

    it('includes fetch status in task output on success', async () => {
      const remoteRepo = createRemote(tmpDir);
      const executionId = 'test-exec-2';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      await executor.testSyncFromRemote(tmpDir, executionId);

      const output = executor.getOutputBuffer(executionId).join('');
      expect(output).toContain('[Git Fetch] Status: success');
      expect(output).toContain('0 commits behind origin/master');

      // Cleanup
      rmSync(remoteRepo, { recursive: true, force: true });
    });

    it('does not check staleness when fetch fails', async () => {
      const executionId = 'test-exec-3';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      // Mock execGitSimple to fail on fetch
      const execGitSpy = vi.spyOn(executor as any, 'execGitSimple');
      execGitSpy.mockImplementation(async (...params: unknown[]) => {
        const args = params[0] as string[];
        if (args[0] === 'fetch') {
          throw new Error('Network error');
        }
        return execSync(`git ${args.join(' ')}`, { cwd: tmpDir, encoding: 'utf8' });
      });

      await expect(executor.testSyncFromRemote(tmpDir, executionId))
        .rejects.toThrow('Git fetch failed: Network error');

      const output = executor.getOutputBuffer(executionId).join('');
      expect(output).toContain('[Git Fetch] Status: FAILED');
      // Should not contain staleness messages
      expect(output).not.toContain('commits behind');
    });

    it('propagates the underlying git error verbatim', async () => {
      const executionId = 'test-exec-ssh';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      const execGitSpy = vi.spyOn(executor as any, 'execGitSimple');
      execGitSpy.mockImplementation(async (...params: unknown[]) => {
        const args = params[0] as string[];
        if (args[0] === 'fetch') {
          throw new Error('SSH authentication failed');
        }
        return execSync(`git ${args.join(' ')}`, { cwd: tmpDir, encoding: 'utf8' });
      });

      await expect(executor.testSyncFromRemote(tmpDir, executionId))
        .rejects.toThrow('Git fetch failed: SSH authentication failed');

      const output = executor.getOutputBuffer(executionId).join('');
      expect(output).toContain('[Git Fetch] Status: FAILED');
      expect(output).toContain('SSH authentication failed');
    });
  });

  describe('staleness detection after successful fetch', () => {
    let executor: TestExecutor;
    let tmpDir: string;
    let remoteRepo: string;

    beforeEach(() => {
      executor = new TestExecutor();
      tmpDir = createTempRepo();
      remoteRepo = createRemote(tmpDir);
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(remoteRepo, { recursive: true, force: true });
    });

    it('warns when local branch is behind remote', async () => {
      // Create a second clone and push commits ahead
      const secondClone = mkdtempSync(join(tmpdir(), 'fetch-failure-clone-'));
      execSync(`git clone ${remoteRepo} ${secondClone}`, { cwd: tmpdir() });
      execSync('git config user.email "test@test.com"', { cwd: secondClone });
      execSync('git config user.name "Test"', { cwd: secondClone });

      // Push 5 commits from second clone
      for (let i = 1; i <= 5; i++) {
        writeFileSync(join(secondClone, `file${i}.txt`), `content${i}`);
        execSync(`git add -A && git commit -m "commit ${i}"`, { cwd: secondClone });
      }
      execSync('git push', { cwd: secondClone });

      const executionId = 'test-exec-staleness-1';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      await executor.testSyncFromRemote(tmpDir, executionId);

      const output = executor.getOutputBuffer(executionId).join('');
      expect(output).toContain('[Git Fetch] Status: success');
      expect(output).toContain('5 commits behind origin/master');

      // Cleanup
      rmSync(secondClone, { recursive: true, force: true });
    });

    it('emits loud warning when >100 commits behind', async () => {
      // Create a second clone and push many commits ahead
      const secondClone = mkdtempSync(join(tmpdir(), 'fetch-failure-clone-'));
      execSync(`git clone ${remoteRepo} ${secondClone}`, { cwd: tmpdir() });
      execSync('git config user.email "test@test.com"', { cwd: secondClone });
      execSync('git config user.name "Test"', { cwd: secondClone });

      // Push 101 commits to trigger loud warning
      for (let i = 1; i <= 101; i++) {
        writeFileSync(join(secondClone, `file${i}.txt`), `content${i}`);
        execSync(`git add -A && git commit -m "commit ${i}"`, { cwd: secondClone });
      }
      execSync('git push', { cwd: secondClone });

      const executionId = 'test-exec-staleness-loud';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      await executor.testSyncFromRemote(tmpDir, executionId);

      const output = executor.getOutputBuffer(executionId).join('');
      expect(output).toContain('101 commits behind origin/master');
      expect(output).toContain('[Git Fetch] WARNING: Local is 101 commits behind origin');

      // Cleanup
      rmSync(secondClone, { recursive: true, force: true });
    });

    it('reports up to date when local matches remote', async () => {
      const executionId = 'test-exec-staleness-uptodate';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      await executor.testSyncFromRemote(tmpDir, executionId);

      const output = executor.getOutputBuffer(executionId).join('');
      expect(output).toContain('[Git Fetch] Status: success');
      expect(output).toContain('0 commits behind origin/master');
    });

    it('handles new branch without remote tracking', async () => {
      // Create a new local branch
      execSync('git checkout -b feature-branch', { cwd: tmpDir });

      const executionId = 'test-exec-new-branch';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      await executor.testSyncFromRemote(tmpDir, executionId);

      const output = executor.getOutputBuffer(executionId).join('');
      expect(output).toContain('[Git Fetch] Status: success');
      expect(output).toContain('no remote tracking branch');
    });
  });
});
