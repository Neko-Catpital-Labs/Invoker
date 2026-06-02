import { describe, expect, it, vi } from 'vitest';
import { LocalBus, Channels } from '@invoker/transport';
import type { TaskDelta, TaskState, TaskStatus } from '@invoker/workflow-core';

import { startLifecycleEventBridge } from '../lifecycle-event-bridge.js';
import {
  WorkerLifecycleEventKinds,
  type WorkerLifecycleEvent,
} from '../lifecycle-events.js';

const createdAt = new Date('2026-01-02T03:04:05.000Z');

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/task-1',
    description: 'task 1',
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1' },
    execution: { generation: 3, selectedAttemptId: 'attempt-1' },
    taskStateVersion: 1,
    ...overrides,
  };
}

function makeUpdatedDelta(status: TaskStatus, taskStateVersion = 2): TaskDelta {
  return {
    type: 'updated',
    taskId: 'wf-1/task-1',
    changes: { status },
    previousTaskStateVersion: taskStateVersion - 1,
    taskStateVersion,
  };
}

function collectLifecycleEvents(bus: LocalBus): WorkerLifecycleEvent[] {
  const events: WorkerLifecycleEvent[] = [];
  bus.subscribe<WorkerLifecycleEvent>(Channels.WORKFLOW_LIFECYCLE, (event) => {
    events.push(event);
  });
  return events;
}

describe('lifecycle-event-bridge', () => {
  it('publishes task.created lifecycle wakeups from created deltas', () => {
    const bus = new LocalBus();
    const events = collectLifecycleEvents(bus);
    startLifecycleEventBridge(bus, { now: () => createdAt });

    bus.publish<TaskDelta>(Channels.TASK_DELTA, { type: 'created', task: makeTask() });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: WorkerLifecycleEventKinds.TASK_CREATED,
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      status: 'pending',
      taskStateVersion: 1,
      generation: 3,
      attemptId: 'attempt-1',
      createdAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it.each([
    ['failed', WorkerLifecycleEventKinds.TASK_FAILED],
    ['completed', WorkerLifecycleEventKinds.TASK_COMPLETED],
    ['review_ready', WorkerLifecycleEventKinds.TASK_REVIEW_READY],
    ['awaiting_approval', WorkerLifecycleEventKinds.TASK_AWAITING_APPROVAL],
    ['needs_input', WorkerLifecycleEventKinds.TASK_NEEDS_INPUT],
  ] as const)('publishes %s lifecycle wakeups from status update deltas', (status, kind) => {
    const bus = new LocalBus();
    const events = collectLifecycleEvents(bus);
    startLifecycleEventBridge(bus, { now: () => createdAt });

    bus.publish<TaskDelta>(Channels.TASK_DELTA, { type: 'created', task: makeTask() });
    bus.publish<TaskDelta>(Channels.TASK_DELTA, makeUpdatedDelta(status));

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      kind,
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      status,
      previousStatus: 'pending',
      previousTaskStateVersion: 1,
      taskStateVersion: 2,
      generation: 3,
      attemptId: 'attempt-1',
    });
  });

  it('publishes task.updated lifecycle wakeups for non-status updates', () => {
    const bus = new LocalBus();
    const events = collectLifecycleEvents(bus);
    startLifecycleEventBridge(bus, { now: () => createdAt });

    bus.publish<TaskDelta>(Channels.TASK_DELTA, { type: 'created', task: makeTask() });
    bus.publish<TaskDelta>(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { execution: { generation: 4, selectedAttemptId: 'attempt-2' } },
      previousTaskStateVersion: 1,
      taskStateVersion: 2,
    });

    expect(events[1]).toMatchObject({
      kind: WorkerLifecycleEventKinds.TASK_UPDATED,
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      previousStatus: 'pending',
      previousTaskStateVersion: 1,
      taskStateVersion: 2,
      generation: 4,
      attemptId: 'attempt-2',
    });
  });

  it('publishes task.removed lifecycle wakeups from removed deltas', () => {
    const bus = new LocalBus();
    const events = collectLifecycleEvents(bus);
    startLifecycleEventBridge(bus, { now: () => createdAt });

    bus.publish<TaskDelta>(Channels.TASK_DELTA, { type: 'created', task: makeTask() });
    bus.publish<TaskDelta>(Channels.TASK_DELTA, {
      type: 'removed',
      taskId: 'wf-1/task-1',
      previousTaskStateVersion: 2,
    });

    expect(events[1]).toMatchObject({
      kind: WorkerLifecycleEventKinds.TASK_REMOVED,
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      taskStateVersion: 2,
      previousTaskStateVersion: 2,
      generation: 3,
      attemptId: 'attempt-1',
    });
  });

  it('does not invoke fix, recreate, external recovery, or task runner behavior', () => {
    const bus = new LocalBus();
    const directActions = {
      fixWithAgent: vi.fn(),
      recreateWorkflow: vi.fn(),
      launchExternalRecovery: vi.fn(),
      executeTasks: vi.fn(),
      checkMergeGateStatuses: vi.fn(),
    };
    startLifecycleEventBridge(bus, { now: () => createdAt });

    bus.publish<TaskDelta>(Channels.TASK_DELTA, { type: 'created', task: makeTask() });
    bus.publish<TaskDelta>(Channels.TASK_DELTA, makeUpdatedDelta('failed'));

    expect(directActions.fixWithAgent).not.toHaveBeenCalled();
    expect(directActions.recreateWorkflow).not.toHaveBeenCalled();
    expect(directActions.launchExternalRecovery).not.toHaveBeenCalled();
    expect(directActions.executeTasks).not.toHaveBeenCalled();
    expect(directActions.checkMergeGateStatuses).not.toHaveBeenCalled();
  });

  it('stops publishing lifecycle events after stop is called', () => {
    const bus = new LocalBus();
    const events = collectLifecycleEvents(bus);
    const bridge = startLifecycleEventBridge(bus, { now: () => createdAt });

    bridge.stop();
    bridge.stop();
    bus.publish<TaskDelta>(Channels.TASK_DELTA, { type: 'created', task: makeTask() });

    expect(events).toHaveLength(0);
  });
});
