import { describe, expect, it } from 'vitest';
import { computeWorkflowRollupFromSummaries, hasFailedDependencyPath } from '../workflow-rollup.js';
import type { TaskStatus } from '../types.js';

function task(id: string, status: TaskStatus, dependencies: string[] = []) {
  return {
    id,
    description: id,
    status,
    dependencies,
  };
}

describe('workflow rollup', () => {
  it.each([
    { name: 'no tasks', statuses: [], expected: 'pending' },
    { name: 'all pending', statuses: ['pending'], expected: 'pending' },
    { name: 'running task', statuses: ['pending', 'running'], expected: 'running' },
    { name: 'fixing task', statuses: ['running', 'fixing_with_ai'], expected: 'fixing_with_ai' },
    { name: 'awaiting approval', statuses: ['completed', 'awaiting_approval'], expected: 'awaiting_approval' },
    { name: 'review ready', statuses: ['completed', 'review_ready'], expected: 'review_ready' },
    { name: 'blocked task', statuses: ['completed', 'blocked'], expected: 'blocked' },
    { name: 'needs input task', statuses: ['completed', 'needs_input'], expected: 'blocked' },
    { name: 'failed with unrelated pending work by counts only', statuses: ['failed', 'pending'], expected: 'failed' },
    { name: 'terminal failed', statuses: ['failed', 'completed'], expected: 'failed' },
    { name: 'closed gate', statuses: ['completed', 'closed'], expected: 'closed' },
    { name: 'running outranks closed', statuses: ['closed', 'running'], expected: 'running' },
    { name: 'awaiting approval outranks closed', statuses: ['closed', 'awaiting_approval'], expected: 'awaiting_approval' },
    { name: 'review ready outranks closed', statuses: ['closed', 'review_ready'], expected: 'review_ready' },
    { name: 'closed outranks blocked', statuses: ['closed', 'blocked'], expected: 'closed' },
    { name: 'completed workflow', statuses: ['completed', 'completed'], expected: 'completed' },
    { name: 'completed with stale prior task', statuses: ['completed', 'stale'], expected: 'completed' },
    { name: 'all stale', statuses: ['stale', 'stale'], expected: 'stale' },
  ])('$name rolls up to $expected', ({ statuses, expected }) => {
    const rollup = computeWorkflowRollupFromSummaries(
      statuses.map((status, index) => task(`task-${index}`, status as TaskStatus)),
    );

    expect(rollup.status).toBe(expected);
  });

  it('fails when all remaining pending work is blocked by a failed dependency', () => {
    const rollup = computeWorkflowRollupFromSummaries([
      task('alpha', 'failed'),
      task('beta', 'pending', ['alpha']),
      task('merge', 'pending', ['beta']),
    ]);

    expect(rollup.status).toBe('failed');
  });

  it('fails when a failed task does not block all remaining pending work', () => {
    const rollup = computeWorkflowRollupFromSummaries([
      task('alpha', 'failed'),
      task('independent', 'pending'),
    ]);

    expect(rollup.status).toBe('failed');
  });

  it('fails a diamond workflow when one ready branch failed and another is still pending', () => {
    const rollup = computeWorkflowRollupFromSummaries([
      task('alpha', 'completed'),
      task('left', 'failed', ['alpha']),
      task('right', 'pending', ['alpha']),
      task('merge', 'pending', ['left', 'right']),
    ]);

    expect(rollup.status).toBe('failed');
  });

  it('closes a workflow when pending work is blocked by a closed dependency', () => {
    const rollup = computeWorkflowRollupFromSummaries([
      task('alpha', 'closed'),
      task('beta', 'pending', ['alpha']),
      task('merge', 'pending', ['beta']),
    ]);

    expect(rollup.status).toBe('closed');
  });

  it('does not report closed tasks as failed issues', () => {
    const rollup = computeWorkflowRollupFromSummaries([
      task('alpha', 'closed'),
      task('beta', 'failed'),
    ]);

    expect(rollup.failedTasks.map((issue) => issue.taskId)).toEqual(['beta']);
  });

  it('counts closed tasks as terminal-neutral (not completed, not failed)', () => {
    const rollup = computeWorkflowRollupFromSummaries([task('alpha', 'closed')]);

    expect(rollup.status).toBe('closed');
    expect(rollup.countsByStatus.closed).toBe(1);
    expect(rollup.countsByStatus.completed).toBe(0);
    expect(rollup.countsByStatus.failed).toBe(0);
    expect(rollup.failedTasks).toEqual([]);
  });

  it('does not roll up to completed when a closed task is mixed with completed tasks', () => {
    const rollup = computeWorkflowRollupFromSummaries([
      task('alpha', 'completed'),
      task('beta', 'completed'),
      task('gamma', 'closed'),
    ]);

    expect(rollup.status).toBe('closed');
    expect(rollup.status).not.toBe('completed');
    expect(rollup.countsByStatus.completed).toBe(2);
    expect(rollup.countsByStatus.closed).toBe(1);
  });
});

describe('hasFailedDependencyPath', () => {
  function mapOf(...tasks: ReturnType<typeof task>[]) {
    return new Map(tasks.map((t) => [t.id, t]));
  }

  it('is true when a direct dependency failed', () => {
    const root = task('root', 'failed');
    const child = task('child', 'blocked', ['root']);
    expect(hasFailedDependencyPath(child, mapOf(root, child))).toBe(true);
  });

  it('is true when a direct dependency is closed', () => {
    const root = task('root', 'closed');
    const child = task('child', 'blocked', ['root']);
    expect(hasFailedDependencyPath(child, mapOf(root, child))).toBe(true);
  });

  it('is true transitively through an intermediate blocked task', () => {
    const root = task('root', 'failed');
    const mid = task('mid', 'blocked', ['root']);
    const leaf = task('leaf', 'blocked', ['mid']);
    expect(hasFailedDependencyPath(leaf, mapOf(root, mid, leaf))).toBe(true);
  });

  it('is false when every dependency is satisfied (external-gate shape)', () => {
    const a = task('a', 'completed');
    const b = task('b', 'completed', ['a']);
    const gate = task('gate', 'blocked', ['a', 'b']);
    expect(hasFailedDependencyPath(gate, mapOf(a, b, gate))).toBe(false);
  });

  it('is false when there are no dependencies', () => {
    expect(hasFailedDependencyPath(task('solo', 'blocked'), mapOf())).toBe(false);
  });
});
