import { describe, expect, it } from 'vitest';

import { shouldAutoFixFromDelta } from '../auto-fix-gating.js';

describe('auto-fix-gating', () => {
  it('does not auto-fix replayed failed state from persistence', () => {
    expect(
      shouldAutoFixFromDelta(
        {
          type: 'updated',
          taskId: 'task-1',
          changes: { status: 'failed' },
        },
        JSON.stringify({ id: 'task-1', status: 'failed' }),
      ),
    ).toBe(false);
  });

  it('does not auto-fix a failure without a prior active snapshot', () => {
    expect(
      shouldAutoFixFromDelta({
        type: 'updated',
        taskId: 'task-1',
        changes: { status: 'failed' },
      }),
    ).toBe(false);
  });

  it('auto-fixes an explicit retry failure even if the cached snapshot is stale', () => {
    expect(
      shouldAutoFixFromDelta(
        {
          type: 'updated',
          taskId: 'task-1',
          changes: { status: 'failed' },
        },
        JSON.stringify({ id: 'task-1', status: 'failed' }),
        { wasExplicitRetry: true },
      ),
    ).toBe(true);
  });

  it('auto-fixes a real running to failed transition', () => {
    expect(
      shouldAutoFixFromDelta(
        {
          type: 'updated',
          taskId: 'task-1',
          changes: { status: 'failed' },
        },
        JSON.stringify({ id: 'task-1', status: 'running' }),
      ),
    ).toBe(true);
  });

  it('auto-fixes a fixing_with_ai to failed transition', () => {
    expect(
      shouldAutoFixFromDelta(
        {
          type: 'updated',
          taskId: 'task-1',
          changes: { status: 'failed' },
        },
        JSON.stringify({ id: 'task-1', status: 'fixing_with_ai' }),
      ),
    ).toBe(true);
  });

  it('does not auto-fix workflow cancellation failures', () => {
    expect(
      shouldAutoFixFromDelta(
        {
          type: 'updated',
          taskId: 'task-1',
          changes: {
            status: 'failed',
            execution: { error: 'Cancelled by user (workflow)' },
          },
        },
        JSON.stringify({ id: 'task-1', status: 'running' }),
      ),
    ).toBe(false);
  });

  it('does not auto-fix downstream cancellation failures', () => {
    expect(
      shouldAutoFixFromDelta(
        {
          type: 'updated',
          taskId: 'task-1',
          changes: {
            status: 'failed',
            execution: { error: 'Cancelled: upstream task "build" was cancelled' },
          },
        },
        JSON.stringify({ id: 'task-1', status: 'running' }),
      ),
    ).toBe(false);
  });

  it('auto-fixes explicit restarted-task failures when they were running before failing', () => {
    expect(
      shouldAutoFixFromDelta(
        {
          type: 'updated',
          taskId: 'wf-1/task-1',
          changes: {
            status: 'failed',
            execution: { error: 'non-zero exit' },
          },
        },
        JSON.stringify({ status: 'running' }),
      ),
    ).toBe(true);
  });
});
