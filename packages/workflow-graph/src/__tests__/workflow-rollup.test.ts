import { describe, expect, it } from 'vitest';
import { computeWorkflowRollupFromSummaries } from '../workflow-rollup.js';
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
    { name: 'failed with unrelated pending work by counts only', statuses: ['failed', 'pending'], expected: 'running' },
    { name: 'terminal failed', statuses: ['failed', 'completed'], expected: 'failed' },
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

  it('keeps running when a failed task does not block all remaining pending work', () => {
    const rollup = computeWorkflowRollupFromSummaries([
      task('alpha', 'failed'),
      task('independent', 'pending'),
    ]);

    expect(rollup.status).toBe('running');
  });
});
