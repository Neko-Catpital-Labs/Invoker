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
    { name: 'failed with unrelated pending work by counts only', statuses: ['failed', 'pending'], expected: 'failed' },
    { name: 'terminal failed', statuses: ['failed', 'completed'], expected: 'failed' },
    { name: 'completed workflow', statuses: ['completed', 'completed'], expected: 'completed' },
    { name: 'completed with stale prior task', statuses: ['completed', 'stale'], expected: 'completed' },
    { name: 'all stale', statuses: ['stale', 'stale'], expected: 'stale' },
    { name: 'closed alongside completed task', statuses: ['completed', 'closed'], expected: 'closed' },
    { name: 'closed alongside pending task', statuses: ['pending', 'closed'], expected: 'closed' },
    { name: 'failed beats closed', statuses: ['failed', 'closed'], expected: 'failed' },
    { name: 'running beats closed', statuses: ['running', 'closed'], expected: 'running' },
    { name: 'review_ready beats closed', statuses: ['review_ready', 'closed'], expected: 'review_ready' },
    { name: 'awaiting_approval beats closed', statuses: ['awaiting_approval', 'closed'], expected: 'awaiting_approval' },
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

  it('classifies closed as terminal-neutral: counted, but not failed and not completed', () => {
    const rollup = computeWorkflowRollupFromSummaries([
      task('alpha', 'completed'),
      task('merge', 'closed'),
    ]);

    expect(rollup.status).toBe('closed');
    expect(rollup.countsByStatus.closed).toBe(1);
    expect(rollup.countsByStatus.completed).toBe(1);
    expect(rollup.countsByStatus.failed).toBe(0);
    expect(rollup.failedTasks).toEqual([]);
  });
});
