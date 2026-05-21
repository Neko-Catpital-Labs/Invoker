import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  CoalescedWorkflowMetadataPublisher,
  WorkflowMetadataInvalidator,
} from '../workflow-metadata-invalidation.js';
import type { Workflow } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

function makeWorkflow(id: string, status: Workflow['status'] = 'pending'): Workflow {
  return {
    id,
    name: id,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeTask(id: string, workflowId: string): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId },
    execution: {},
    taskStateVersion: 1,
  };
}

describe('WorkflowMetadataInvalidator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes backend workflow metadata after a created task delta', () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const invalidator = new WorkflowMetadataInvalidator({
      getCachedTaskSnapshot: () => undefined,
      loadTask: () => undefined,
      listWorkflows: () => [makeWorkflow('wf-1', 'running')],
      publish,
      flushMs: 25,
    });

    invalidator.markFromTaskDelta({ type: 'created', task: makeTask('task-1', 'wf-1') });

    expect(publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(25);
    expect(publish).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'wf-1', status: 'running' })],
      {
        coalescedRequests: 1,
        reasonCounts: { taskDelta: 1 },
      },
    );
  });

  it('uses the cached pre-delete task snapshot for removed deltas', () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const invalidator = new WorkflowMetadataInvalidator({
      getCachedTaskSnapshot: (taskId) => JSON.stringify(makeTask(taskId, 'wf-removed')),
      loadTask: () => undefined,
      listWorkflows: () => [makeWorkflow('wf-removed', 'pending')],
      publish,
      flushMs: 25,
    });

    invalidator.markFromTaskDelta({ type: 'removed', taskId: 'task-1', previousTaskStateVersion: 1 });
    vi.advanceTimersByTime(25);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toEqual([expect.objectContaining({ id: 'wf-removed' })]);
  });

  it('marks both old and new workflows when an updated task moves between workflows', () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const invalidator = new WorkflowMetadataInvalidator({
      getCachedTaskSnapshot: (taskId) => JSON.stringify(makeTask(taskId, 'wf-old')),
      loadTask: () => undefined,
      listWorkflows: () => [makeWorkflow('wf-old', 'pending'), makeWorkflow('wf-new', 'running')],
      publish,
      flushMs: 25,
    });

    invalidator.markFromTaskDelta({
      type: 'updated',
      taskId: 'task-1',
      changes: { config: { workflowId: 'wf-new' } },
      previousTaskStateVersion: 1,
      taskStateVersion: 2,
    });
    vi.advanceTimersByTime(25);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: 'wf-old' }),
      expect.objectContaining({ id: 'wf-new' }),
    ]);
  });

  it('coalesces rapid task deltas into one workflow metadata publish', () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const invalidator = new WorkflowMetadataInvalidator({
      getCachedTaskSnapshot: () => undefined,
      loadTask: () => undefined,
      listWorkflows: () => [makeWorkflow('wf-1')],
      publish,
      flushMs: 25,
    });

    invalidator.markFromTaskDelta({ type: 'created', task: makeTask('task-1', 'wf-1') });
    invalidator.markFromTaskDelta({ type: 'created', task: makeTask('task-2', 'wf-1') });
    vi.advanceTimersByTime(25);

    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('CoalescedWorkflowMetadataPublisher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid publish requests into one latest listWorkflows snapshot', () => {
    vi.useFakeTimers();
    let currentSnapshot = [makeWorkflow('wf-old', 'pending')];
    const listWorkflows = vi.fn(() => currentSnapshot);
    const publish = vi.fn();
    const publisher = new CoalescedWorkflowMetadataPublisher({
      listWorkflows,
      publish,
      flushMs: 50,
    });

    publisher.requestPublish('first');
    publisher.requestPublish('second');
    publisher.requestPublish('second');
    currentSnapshot = [makeWorkflow('wf-new', 'running')];

    expect(listWorkflows).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);

    expect(listWorkflows).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'wf-new' })],
      {
        coalescedRequests: 3,
        reasonCounts: { first: 1, second: 2 },
      },
    );

    publisher.requestPublish('third');
    currentSnapshot = [makeWorkflow('wf-final', 'completed')];
    vi.advanceTimersByTime(50);

    expect(listWorkflows).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: 'wf-final' })],
      {
        coalescedRequests: 1,
        reasonCounts: { third: 1 },
      },
    );
  });
});
