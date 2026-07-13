/**
 * Regression repro: the workflow list must never blank out — and must self-heal —
 * under the recreate/quarantine storm that the recovery worker + db-poll watchdog
 * drive across all workflows.
 *
 * Two distinct failure modes are proven here:
 *  A) A `{ removed: true }` rollup patch HARD-deletes a workflow even when a task
 *     still references it (a transient-empty projection during the storm). The
 *     entry vanishes and never returns.
 *  B) Once the map has lost a workflow, no delta batch re-fetches it: only a
 *     `created` delta for an unknown workflow triggered a re-fetch, so idle/pending
 *     workflows stayed gone forever.
 *
 * Both assertions describe the CORRECT post-fix behavior; they fail on the
 * pre-fix code (proving the bug) and pass after the fix.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTasks } from '../hooks/useTasks.js';
import { makeUITask } from './helpers/mock-invoker.js';
import type { WorkflowMeta } from '../types.js';

/** Awaits the 100ms delta-pipeline flush window without the executor callback form. */
function flushPipeline(ms = 130): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function makeWorkflowRollup(
  status: NonNullable<WorkflowMeta['rollup']>['status'],
  counts: Partial<NonNullable<WorkflowMeta['rollup']>['countsByStatus']> = {},
): NonNullable<WorkflowMeta['rollup']> {
  return {
    status,
    countsByStatus: {
      pending: 0,
      running: 0,
      fixing_with_ai: 0,
      completed: 0,
      failed: 0,
      closed: 0,
      needs_input: 0,
      blocked: 0,
      review_ready: 0,
      awaiting_approval: 0,
      stale: 0,
      ...counts,
    },
    failedTasks: [],
    fixingTasks: [],
    waitingTasks: [],
  };
}

describe('workflow list blank-out under storm', () => {
  let taskGraphEventHandler: ((event: unknown) => void) | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    taskGraphEventHandler = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { invoker?: unknown }).invoker;
    delete (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__;
  });

  it('keeps a workflow whose removed rollup arrives while a task still references it', async () => {
    const tasks = [
      makeUITask({ id: 'wf-1/task-1', workflowId: 'wf-1', status: 'pending' }),
      makeUITask({ id: 'wf-2/task-1', workflowId: 'wf-2', status: 'pending' }),
      makeUITask({ id: 'wf-3/task-1', workflowId: 'wf-3', status: 'pending' }),
    ];
    const workflows: WorkflowMeta[] = [
      { id: 'wf-1', name: 'Workflow 1', status: 'pending' },
      { id: 'wf-2', name: 'Workflow 2', status: 'pending' },
      { id: 'wf-3', name: 'Workflow 3', status: 'pending' },
    ];
    const listWorkflows = vi.fn().mockResolvedValue(workflows);
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = { tasks, workflows };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockResolvedValue({ tasks, workflows }),
      listWorkflows,
      reportUiPerf: vi.fn().mockResolvedValue(undefined),
      onTaskGraphEvent: vi.fn((cb: (event: unknown) => void) => {
        taskGraphEventHandler = cb;
        return () => {};
      }),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());
    expect(result.current.workflows.size).toBe(3);

    // Storm: wf-2's task set transiently empties in the projection, emitting a
    // removed rollup — but the task is still present in this very batch.
    await act(async () => {
      taskGraphEventHandler!({
        type: 'delta',
        delta: {
          type: 'updated',
          taskId: 'wf-2/task-1',
          changes: { status: 'running' },
          taskStateVersion: 2,
          previousTaskStateVersion: 1,
        },
        workflowRollups: [
          { workflowId: 'wf-2', status: 'pending', rollup: makeWorkflowRollup('pending'), removed: true },
        ],
      });
      await flushPipeline();
    });

    // wf-2 is still task-backed, so it must survive the removed rollup.
    expect(result.current.workflows.has('wf-2')).toBe(true);
    expect(result.current.workflows.size).toBe(3);
    expect(result.current.tasks.get('wf-2/task-1')?.status).toBe('running');
    // No spurious full re-fetch: the entry never left, nothing references a missing workflow.
    expect(listWorkflows).not.toHaveBeenCalled();
  });

  it('self-heals: re-fetches the workflow list when a batch references workflows the map lost', async () => {
    // Simulate the already-wiped state: tasks are present but the workflow map
    // has been emptied by an earlier storm event.
    const tasks = [
      makeUITask({ id: 'wf-1/task-1', workflowId: 'wf-1', status: 'pending' }),
      makeUITask({ id: 'wf-2/task-1', workflowId: 'wf-2', status: 'pending' }),
      makeUITask({ id: 'wf-3/task-1', workflowId: 'wf-3', status: 'pending' }),
    ];
    const workflows: WorkflowMeta[] = [
      { id: 'wf-1', name: 'Workflow 1', status: 'pending' },
      { id: 'wf-2', name: 'Workflow 2', status: 'pending' },
      { id: 'wf-3', name: 'Workflow 3', status: 'pending' },
    ];
    const listWorkflows = vi.fn().mockResolvedValue(workflows);
    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = { tasks, workflows: [] };
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn().mockResolvedValue({ tasks, workflows: [] }),
      listWorkflows,
      reportUiPerf: vi.fn().mockResolvedValue(undefined),
      onTaskGraphEvent: vi.fn((cb: (event: unknown) => void) => {
        taskGraphEventHandler = cb;
        return () => {};
      }),
      onWorkflowsChanged: vi.fn(() => () => {}),
    };

    const { result } = renderHook(() => useTasks());
    expect(result.current.workflows.size).toBe(0);

    // Any routine task delta arrives during the storm; the idle/pending workflows
    // emit no `created` delta, so only a general missing-reference check can heal.
    await act(async () => {
      taskGraphEventHandler!({
        type: 'delta',
        delta: {
          type: 'updated',
          taskId: 'wf-1/task-1',
          changes: { status: 'running' },
          taskStateVersion: 2,
          previousTaskStateVersion: 1,
        },
        workflowRollups: [],
      });
      await flushPipeline();
    });

    await waitFor(() => {
      expect(listWorkflows).toHaveBeenCalled();
      expect(result.current.workflows.size).toBe(3);
    });
    expect(result.current.workflows.get('wf-2')?.name).toBe('Workflow 2');
  });
});
