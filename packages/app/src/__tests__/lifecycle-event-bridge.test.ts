import { describe, expect, it, vi } from 'vitest';
import { Channels, LocalBus, type MessageBus } from '@invoker/transport';
import type { TaskDelta, TaskState } from '@invoker/workflow-core';
import {
  isWorkflowLifecycleEvent,
  type WorkflowLifecycleEvent,
} from '../lifecycle-events.js';
import { startLifecycleEventBridge } from '../lifecycle-event-bridge.js';

const CREATED_AT = '2026-06-04T00:00:00.000Z';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/task-a',
    description: 'test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-06-03T00:00:00.000Z'),
    config: { workflowId: 'wf-1' },
    execution: { generation: 3, selectedAttemptId: 'attempt-1' },
    taskStateVersion: 1,
    ...overrides,
  } as TaskState;
}

function collectLifecycleEvents(bus: MessageBus): WorkflowLifecycleEvent[] {
  const events: WorkflowLifecycleEvent[] = [];
  bus.subscribe<WorkflowLifecycleEvent>(Channels.WORKFLOW_LIFECYCLE, (event) => events.push(event));
  return events;
}

function expectRecoveryWakeup(event: any, expected: Record<string, unknown>): void {
  expect(event.recoveryWakeup).toEqual({
    eventKey: event.eventKey,
    eventKind: event.kind,
    workflowId: event.workflowId,
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.taskStateVersion != null ? { taskStateVersion: event.taskStateVersion } : {}),
    generation: event.generation,
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    createdAt: event.createdAt,
    authoritative: false,
    ...expected,
  });
}

describe('lifecycle event bridge', () => {
  it('publishes task.created lifecycle events from created deltas', () => {
    const bus = new LocalBus();
    const events = collectLifecycleEvents(bus);
    startLifecycleEventBridge({ messageBus: bus, now: () => CREATED_AT });

    bus.publish<TaskDelta>(Channels.TASK_DELTA, { type: 'created', task: makeTask() });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventKey: 'task.created|workflow:wf-1|task:wf-1/task-a|generation:3|attempt:attempt-1|task-state:1',
      kind: 'task.created',
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      status: 'pending',
      taskStateVersion: 1,
      generation: 3,
      attemptId: 'attempt-1',
      createdAt: CREATED_AT,
    });
    expect(isWorkflowLifecycleEvent(events[0])).toBe(true);
    expectRecoveryWakeup(events[0], { reason: 'task_lifecycle' });
  });

  it.each([
    ['failed', 'task.failed'],
    ['completed', 'task.completed'],
    ['review_ready', 'task.review_ready'],
    ['awaiting_approval', 'task.awaiting_approval'],
    ['needs_input', 'task.needs_input'],
  ] as const)('publishes %s status updates as %s lifecycle events', (status, kind) => {
    const bus = new LocalBus();
    const events = collectLifecycleEvents(bus);
    startLifecycleEventBridge({
      messageBus: bus,
      getInitialTasks: () => [makeTask({ status: 'running', taskStateVersion: 5 })],
      now: () => CREATED_AT,
    });

    bus.publish<TaskDelta>(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-a',
      changes: { status, execution: { generation: 4, selectedAttemptId: 'attempt-2' } },
      taskStateVersion: 6,
      previousTaskStateVersion: 5,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventKey: `${kind}|workflow:wf-1|task:wf-1/task-a|generation:4|attempt:attempt-2|task-state:6`,
      kind,
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      status,
      previousStatus: 'running',
      taskStateVersion: 6,
      generation: 4,
      attemptId: 'attempt-2',
      createdAt: CREATED_AT,
    });
    expectRecoveryWakeup(events[0], {
      reason: kind === 'task.failed' ? 'task_failure' : 'task_lifecycle',
    });
  });

  it('publishes task.updated for non-status updates using cached task status', () => {
    const bus = new LocalBus();
    const events = collectLifecycleEvents(bus);
    startLifecycleEventBridge({
      messageBus: bus,
      getInitialTasks: () => [makeTask({ status: 'running', taskStateVersion: 8 })],
      now: () => CREATED_AT,
    });

    bus.publish<TaskDelta>(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-a',
      changes: { execution: { branch: 'feature/test' } },
      taskStateVersion: 9,
      previousTaskStateVersion: 8,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventKey: 'task.updated|workflow:wf-1|task:wf-1/task-a|generation:3|attempt:attempt-1|task-state:9',
      kind: 'task.updated',
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      status: 'running',
      previousStatus: 'running',
      taskStateVersion: 9,
      generation: 3,
      attemptId: 'attempt-1',
      createdAt: CREATED_AT,
    });
    expectRecoveryWakeup(events[0], { reason: 'task_lifecycle' });
  });

  it('publishes task.removed lifecycle events from removed deltas', () => {
    const bus = new LocalBus();
    const events = collectLifecycleEvents(bus);
    startLifecycleEventBridge({
      messageBus: bus,
      getInitialTasks: () => [makeTask({ status: 'failed', taskStateVersion: 9 })],
      now: () => CREATED_AT,
    });

    bus.publish<TaskDelta>(Channels.TASK_DELTA, {
      type: 'removed',
      taskId: 'wf-1/task-a',
      previousTaskStateVersion: 9,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventKey: 'task.removed|workflow:wf-1|task:wf-1/task-a|generation:3|attempt:attempt-1|task-state:9',
      kind: 'task.removed',
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      status: 'failed',
      previousStatus: 'failed',
      taskStateVersion: 9,
      generation: 3,
      attemptId: 'attempt-1',
      createdAt: CREATED_AT,
    });
    expectRecoveryWakeup(events[0], { reason: 'task_lifecycle' });
  });

  it('does not call recovery or TaskRunner methods while publishing wakeups', () => {
    const bus = new LocalBus();
    const recoverySurface = {
      fixWithAgent: vi.fn(),
      executeTasks: vi.fn(),
      recreateWorkflowFromFreshBase: vi.fn(),
      launchExternalRecovery: vi.fn(),
      resolveConflict: vi.fn(),
    };
    startLifecycleEventBridge({
      messageBus: bus,
      getInitialTasks: () => [makeTask({ status: 'running', taskStateVersion: 5 })],
      now: () => CREATED_AT,
    });

    bus.publish<TaskDelta>(Channels.TASK_DELTA, {
      type: 'updated',
      taskId: 'wf-1/task-a',
      changes: { status: 'failed' },
      taskStateVersion: 6,
      previousTaskStateVersion: 5,
    });

    expect(recoverySurface.fixWithAgent).not.toHaveBeenCalled();
    expect(recoverySurface.executeTasks).not.toHaveBeenCalled();
    expect(recoverySurface.recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
    expect(recoverySurface.launchExternalRecovery).not.toHaveBeenCalled();
    expect(recoverySurface.resolveConflict).not.toHaveBeenCalled();
  });

  it('unsubscribes cleanly', () => {
    const bus = new LocalBus();
    const events = collectLifecycleEvents(bus);
    const bridge = startLifecycleEventBridge({ messageBus: bus, now: () => CREATED_AT });

    bridge.stop();
    bus.publish<TaskDelta>(Channels.TASK_DELTA, { type: 'created', task: makeTask() });

    expect(events).toEqual([]);
  });
});
