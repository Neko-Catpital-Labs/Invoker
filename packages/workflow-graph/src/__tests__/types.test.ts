import { describe, it, expect } from 'vitest';
import { createTaskState, createAttempt } from '../types.js';
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

  it('copies dependencies without shared reference', () => {
    const deps = ['a', 'b'];
    const task = createTaskState('t', 'desc', deps);
    deps.push('c');
    expect(task.dependencies).toEqual(['a', 'b']);
  });
});

describe('createAttempt', () => {
  it('creates attempt with correct defaults', () => {
    const attempt = createAttempt('taskA');

    expect(attempt.id).toMatch(/^taskA-a[0-9a-f]{8}$/);
    expect(attempt.nodeId).toBe('taskA');
    expect(attempt.status).toBe('pending');
    expect(attempt.upstreamAttemptIds).toEqual([]);
    expect(attempt.createdAt).toBeInstanceOf(Date);
    expect(attempt.snapshotCommit).toBeUndefined();
    expect(attempt.commandOverride).toBeUndefined();
    expect(attempt.supersedesAttemptId).toBeUndefined();
  });

  it('generates unique IDs with nodeId prefix', () => {
    const a1 = createAttempt('taskA');
    const a2 = createAttempt('taskA');
    expect(a1.id).toMatch(/^taskA-a[0-9a-f]{8}$/);
    expect(a2.id).toMatch(/^taskA-a[0-9a-f]{8}$/);
    expect(a1.id).not.toBe(a2.id);
  });

  it('accepts overrides', () => {
    const attempt = createAttempt('taskB', {
      status: 'running',
      snapshotCommit: 'abc123',
      commandOverride: 'pnpm test -- --watch',
      upstreamAttemptIds: ['taskA-a1'],
      supersedesAttemptId: 'taskB-a1',
    });

    expect(attempt.id).toMatch(/^taskB-a[0-9a-f]{8}$/);
    expect(attempt.status).toBe('running');
    expect(attempt.snapshotCommit).toBe('abc123');
    expect(attempt.commandOverride).toBe('pnpm test -- --watch');
    expect(attempt.upstreamAttemptIds).toEqual(['taskA-a1']);
    expect(attempt.supersedesAttemptId).toBe('taskB-a1');
  });

  it('preserves mergeConflict field', () => {
    const attempt = createAttempt('merge-task', {
      mergeConflict: {
        failedBranch: 'feat/broken',
        conflictFiles: ['src/main.ts', 'package.json'],
      },
    });

    expect(attempt.mergeConflict).toEqual({
      failedBranch: 'feat/broken',
      conflictFiles: ['src/main.ts', 'package.json'],
    });
  });
});

describe('createTaskState', () => {
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
      featureBranch: 'feat/clone',
      familiarType: 'worktree',
      autoFix: true,
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
