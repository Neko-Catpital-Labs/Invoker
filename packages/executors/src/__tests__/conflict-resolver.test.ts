import { describe, it, expect } from 'vitest';
import { buildFixPrompt, resolveConflictWithClaudeImpl } from '../conflict-resolver.js';
import type { ConflictResolverHost } from '../conflict-resolver.js';
import type { Orchestrator } from '@invoker/core';

describe('buildFixPrompt', () => {
  it('generates command-focused prompt when task has a command', () => {
    const task = {
      description: 'Run unit tests',
      config: { command: 'pnpm test' },
      execution: { error: 'Test failed' },
    };
    const prompt = buildFixPrompt(task, 'FAIL: expected 1 to equal 2');
    expect(prompt).toContain('build/test command failed');
    expect(prompt).toContain('Command: pnpm test');
    expect(prompt).toContain('Do NOT modify the command itself');
    expect(prompt).not.toContain('merge operation');
  });

  it('generates merge-focused prompt for merge gate nodes', () => {
    const task = {
      description: 'Merge gate for workflow',
      config: { isMergeNode: true },
      execution: { error: 'Merge failed: conflict in src/index.ts' },
    };
    const prompt = buildFixPrompt(task, 'CONFLICT (content): Merge conflict in src/index.ts');
    expect(prompt).toContain('merge operation failed');
    expect(prompt).toContain('Merge failed: conflict in src/index.ts');
    expect(prompt).toContain('merge cleanly');
    expect(prompt).not.toContain('build/test command');
  });

  it('generates generic prompt for prompt-only tasks', () => {
    const task = {
      description: 'Implement feature X',
      config: { prompt: 'Add feature X to the codebase' },
      execution: { error: 'Claude exited with code 1' },
    };
    const prompt = buildFixPrompt(task, 'Error: file not found');
    expect(prompt).toContain('task failed');
    expect(prompt).toContain('Original prompt: Add feature X');
    expect(prompt).toContain('Claude exited with code 1');
    expect(prompt).not.toContain('build/test command');
    expect(prompt).not.toContain('merge operation');
  });

  it('includes last 200 lines of output', () => {
    const longOutput = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const task = {
      description: 'Test task',
      config: { command: 'npm test' },
      execution: {},
    };
    const prompt = buildFixPrompt(task, longOutput);
    expect(prompt).toContain('line 100');
    expect(prompt).toContain('line 299');
    expect(prompt).not.toContain('line 99');
  });

  it('handles empty output gracefully', () => {
    const task = {
      description: 'Test task',
      config: { command: 'npm test' },
      execution: { error: 'exit code 1' },
    };
    const prompt = buildFixPrompt(task, '');
    expect(prompt).toContain('build/test command failed');
  });

  it('handles merge gate with no error message', () => {
    const task = {
      description: 'Merge gate',
      config: { isMergeNode: true },
      execution: {},
    };
    const prompt = buildFixPrompt(task, '');
    expect(prompt).toContain('merge operation failed');
    expect(prompt).toContain('Unknown error');
  });
});

describe('resolveConflictWithClaudeImpl — savedError param', () => {
  function makeHost(task: Record<string, any>): ConflictResolverHost {
    return {
      orchestrator: {
        getTask: () => task,
        getAllTasks: () => [],
      } as unknown as Orchestrator,
      persistence: {} as any,
      cwd: '/tmp',
      execGitReadonly: async () => '',
      execGitIn: async () => '',
      createMergeWorktree: async () => '/tmp/wt',
      removeMergeWorktree: async () => {},
      spawnAgentFix: async () => ({ stdout: '', sessionId: '' }),
    };
  }

  it('throws "no error information" when error was cleared and no savedError provided', async () => {
    const task = {
      id: 'task-1',
      status: 'fixing_with_ai',
      execution: { error: undefined },
      config: {},
    };
    await expect(
      resolveConflictWithClaudeImpl(makeHost(task), 'task-1'),
    ).rejects.toThrow('no error information');
  });

  it('uses savedError to proceed past error check when task.execution.error is cleared', async () => {
    const conflictError = JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'invoker/dep-1',
      conflictFiles: ['src/index.ts'],
    });
    const task = {
      id: 'task-1',
      status: 'fixing_with_ai',
      execution: { error: undefined, branch: 'invoker/task-1', workspacePath: '/tmp/ws' },
      config: {},
    };
    // With savedError the function should NOT throw "no error information".
    // Mocked git ops succeed, so it resolves cleanly.
    await expect(
      resolveConflictWithClaudeImpl(makeHost(task), 'task-1', conflictError),
    ).resolves.toBeUndefined();
  });
});
