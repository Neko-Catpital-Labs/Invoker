/**
 * Integration test: verify fetch status is visible in task output.
 *
 * Tests that when a executor runs a task, the fetch status information
 * appears in the task output buffer in the correct format.
 *
 * Validates both success and failure cases with the expected format:
 * - Success: "[Git Fetch] Status: success | Last fetch: X ago | Staleness: Y commits behind Z"
 * - Failure: "[Git Fetch] Status: FAILED | Error: <message> | Using local state (may be stale)"
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
  const dir = mkdtempSync(join(tmpdir(), 'fetch-status-output-test-'));
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
  const remote = mkdtempSync(join(tmpdir(), 'fetch-status-output-remote-'));
  execSync('git init --bare -b master', { cwd: remote });
  execSync(`git remote add origin ${remote}`, { cwd: localRepo });
  execSync('git push -u origin master', { cwd: localRepo });
  return remote;
}

describe('fetch status visibility in task output', () => {
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
    vi.restoreAllMocks();
  });

  describe('successful fetch', () => {
    it('includes fetch status line in task output', async () => {
      const executionId = 'test-exec-success';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      await executor.testSyncFromRemote(tmpDir, executionId);

      const output = executor.getOutputBuffer(executionId).join('');

      // Verify status line is present
      expect(output).toContain('[Git Fetch] Status: success');

      // Verify it includes all required components
      expect(output).toMatch(/\[Git Fetch\] Status: success \| Last fetch: .* ago \| Staleness: /);
    });

    it('shows up-to-date status when no commits behind', async () => {
      const executionId = 'test-exec-uptodate';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      await executor.testSyncFromRemote(tmpDir, executionId);

      const output = executor.getOutputBuffer(executionId).join('');
      expect(output).toContain('Status: success');
      expect(output).toContain('0 commits behind origin/master');
    });

    it('shows staleness when commits behind', async () => {
      // Create a second clone and push commits ahead
      const secondClone = mkdtempSync(join(tmpdir(), 'fetch-status-clone-'));
      execSync(`git clone ${remoteRepo} ${secondClone}`, { cwd: tmpdir() });
      execSync('git checkout -B master origin/master', { cwd: secondClone });
      execSync('git config user.email "test@test.com"', { cwd: secondClone });
      execSync('git config user.name "Test"', { cwd: secondClone });

      // Push 3 commits from second clone
      for (let i = 1; i <= 3; i++) {
        writeFileSync(join(secondClone, `file${i}.txt`), `content${i}`);
        execSync(`git add -A && git commit -m "commit ${i}"`, { cwd: secondClone });
      }
      execSync('git push', { cwd: secondClone });

      const executionId = 'test-exec-behind';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      await executor.testSyncFromRemote(tmpDir, executionId);

      const output = executor.getOutputBuffer(executionId).join('');
      expect(output).toContain('Status: success');
      expect(output).toContain('3 commits behind origin/master');

      // Cleanup
      rmSync(secondClone, { recursive: true, force: true });
    });

    it('emits loud warning when >100 commits behind', async () => {
      // Create a second clone and push many commits ahead
      const secondClone = mkdtempSync(join(tmpdir(), 'fetch-status-clone-'));
      execSync(`git clone ${remoteRepo} ${secondClone}`, { cwd: tmpdir() });
      execSync('git checkout -B master origin/master', { cwd: secondClone });
      execSync('git config user.email "test@test.com"', { cwd: secondClone });
      execSync('git config user.name "Test"', { cwd: secondClone });

      // Push 101 commits to trigger loud warning
      for (let i = 1; i <= 101; i++) {
        writeFileSync(join(secondClone, `file${i}.txt`), `content${i}`);
        execSync(`git add -A && git commit -m "commit ${i}"`, { cwd: secondClone });
      }
      execSync('git push', { cwd: secondClone });

      const executionId = 'test-exec-very-behind';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      await executor.testSyncFromRemote(tmpDir, executionId);

      const output = executor.getOutputBuffer(executionId).join('');
      expect(output).toContain('Status: success');
      expect(output).toContain('101 commits behind origin/master');
      expect(output).toContain('[Git Fetch] WARNING: Local is 101 commits behind origin');

      // Cleanup
      rmSync(secondClone, { recursive: true, force: true });
    });

    it('handles new branch without remote tracking', async () => {
      // Create a new local branch
      execSync('git checkout -b feature-branch', { cwd: tmpDir });

      const executionId = 'test-exec-new-branch';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      await executor.testSyncFromRemote(tmpDir, executionId);

      const output = executor.getOutputBuffer(executionId).join('');
      expect(output).toContain('Status: success');
      expect(output).toContain('no remote tracking branch');
    });
  });

  describe('failed fetch', () => {
    it('includes failure status line in task output and throws', async () => {
      const executionId = 'test-exec-fail';
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

      // Fetch failures are always fatal
      await expect(executor.testSyncFromRemote(tmpDir, executionId))
        .rejects.toThrow('Git fetch failed: Connection timed out');

      const output = executor.getOutputBuffer(executionId).join('');

      // Verify failure status line is present
      expect(output).toContain('[Git Fetch] Status: FAILED');

      // Verify it includes all required components
      expect(output).toMatch(/\[Git Fetch\] Status: FAILED \| Error: .* \| Aborting task/);
    });

    it('shows error message in failure status', async () => {
      const executionId = 'test-exec-error-msg';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      // Mock execGitSimple to fail with specific error
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
      expect(output).toContain('Error: SSH authentication failed');
      expect(output).toContain('Aborting task');
    });

    it('does not check staleness when fetch fails', async () => {
      const executionId = 'test-exec-no-staleness';
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
      expect(output).not.toContain('Staleness:');
    });
  });

  describe('output format validation', () => {
    it('uses pipe delimiters for success status', async () => {
      const executionId = 'test-format-success';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      await executor.testSyncFromRemote(tmpDir, executionId);

      const output = executor.getOutputBuffer(executionId).join('');
      const statusLine = output.split('\n').find(line => line.includes('[Git Fetch] Status: success'));

      expect(statusLine).toBeDefined();
      // Verify format: "[Git Fetch] Status: success | Last fetch: X | Staleness: Y"
      expect(statusLine).toMatch(/\[Git Fetch\] Status: success \| Last fetch: .+ \| Staleness: .+/);
    });

    it('uses pipe delimiters for failure status', async () => {
      const executionId = 'test-format-fail';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      // Mock execGitSimple to fail on fetch
      const execGitSpy = vi.spyOn(executor as any, 'execGitSimple');
      execGitSpy.mockImplementation(async (...params: unknown[]) => {
        const args = params[0] as string[];
        if (args[0] === 'fetch') {
          throw new Error('Test error');
        }
        return execSync(`git ${args.join(' ')}`, { cwd: tmpDir, encoding: 'utf8' });
      });

      await expect(executor.testSyncFromRemote(tmpDir, executionId))
        .rejects.toThrow('Git fetch failed: Test error');

      const output = executor.getOutputBuffer(executionId).join('');
      const statusLine = output.split('\n').find(line => line.includes('[Git Fetch] Status: FAILED'));

      expect(statusLine).toBeDefined();
      // Verify format: "[Git Fetch] Status: FAILED | Error: X | Aborting task"
      expect(statusLine).toMatch(/\[Git Fetch\] Status: FAILED \| Error: .+ \| Aborting task/);
    });

    it('ends status line with newline', async () => {
      const executionId = 'test-newline';
      executor.registerTestEntry(executionId, makeRequest('test-action'));

      await executor.testSyncFromRemote(tmpDir, executionId);

      const output = executor.getOutputBuffer(executionId);
      const statusChunk = output.find(chunk => chunk.includes('[Git Fetch] Status:'));

      expect(statusChunk).toBeDefined();
      expect(statusChunk).toMatch(/\n$/);
    });
  });
});
