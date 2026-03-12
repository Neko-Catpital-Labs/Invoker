import { describe, it, expect } from 'vitest';
import { createTaskState } from '../types.js';
import type { TaskConfig } from '../types.js';

describe('createTaskState', () => {
  it('returns nested structure with config and execution', () => {
    const task = createTaskState('t1', 'desc', ['dep'], {
      command: 'echo hi',
      isReconciliation: true,
    });

    expect(task.id).toBe('t1');
    expect(task.description).toBe('desc');
    expect(task.status).toBe('pending');
    expect(task.dependencies).toEqual(['dep']);
    expect(task.createdAt).toBeInstanceOf(Date);
    expect(task.config.command).toBe('echo hi');
    expect(task.config.isReconciliation).toBe(true);
    expect(task.execution).toEqual({});
  });

  it('defaults to empty config and execution', () => {
    const task = createTaskState('t2', 'plain task', []);

    expect(task.config).toEqual({});
    expect(task.execution).toEqual({});
  });

  it('config is fully copyable for cloning', () => {
    const fullConfig: TaskConfig = {
      workflowId: 'wf-1',
      parentTask: 'parent-1',
      command: 'pnpm test',
      prompt: 'do things',
      experimentPrompt: 'try X',
      pivot: true,
      experimentVariants: [{ id: 'v1', description: 'variant 1' }],
      isReconciliation: true,
      requiresManualApproval: true,
      repoUrl: 'https://github.com/test/repo',
      featureBranch: 'feat/clone',
      familiarType: 'worktree',
      autoFix: true,
      maxFixAttempts: 3,
      isMergeNode: false,
      summary: 'summary text',
      problem: 'problem text',
      approach: 'approach text',
      testPlan: 'test plan text',
      reproCommand: 'npm run repro',
    };

    const original = createTaskState('orig', 'original', ['a'], fullConfig);
    const clone = createTaskState('clone', 'cloned', ['b'], original.config);

    expect(clone.config).toEqual(original.config);
    expect(clone.id).toBe('clone');
    expect(clone.dependencies).toEqual(['b']);
    expect(clone.execution).toEqual({});
  });
});
