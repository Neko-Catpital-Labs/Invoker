import { describe, it, expect } from 'vitest';
import { createTaskDeltaStreamSequence } from '../task-delta-stream-sequence.js';
import type { TaskDelta, TaskState } from '@invoker/workflow-core';

function makeTask(id: string): TaskState {
  return {
    id,
    description: `task ${id}`,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2025-01-01'),
    config: {},
    execution: {},
    taskStateVersion: 1,
  } as TaskState;
}

describe('createTaskDeltaStreamSequence', () => {
  it('starts at 0 and is non-incrementing on current()', () => {
    const s = createTaskDeltaStreamSequence();
    expect(s.current()).toBe(0);
    expect(s.current()).toBe(0);
    expect(s.current()).toBe(0);
  });

  it('stamps strictly monotonically increasing sequences starting at 1', () => {
    const s = createTaskDeltaStreamSequence();
    const stamped = [
      s.stamp({ type: 'created', task: makeTask('a') }),
      s.stamp({ type: 'created', task: makeTask('b') }),
      s.stamp({ type: 'updated', taskId: 'b', changes: { status: 'running' }, taskStateVersion: 2, previousTaskStateVersion: 1 }),
      s.stamp({ type: 'removed', taskId: 'a', previousTaskStateVersion: 1 }),
    ];
    expect(stamped.map((d) => d.streamSequence)).toEqual([1, 2, 3, 4]);
  });

  it('current() after stamp() returns the just-stamped sequence', () => {
    const s = createTaskDeltaStreamSequence();
    s.stamp({ type: 'created', task: makeTask('a') });
    expect(s.current()).toBe(1);
    s.stamp({ type: 'created', task: makeTask('b') });
    expect(s.current()).toBe(2);
  });

  it('overwrites any incoming streamSequence on the input delta', () => {
    const s = createTaskDeltaStreamSequence();
    const stamped = s.stamp({
      type: 'updated',
      taskId: 'a',
      changes: { status: 'running' },
      taskStateVersion: 2,
      previousTaskStateVersion: 1,
      streamSequence: 999,
    } as TaskDelta);
    expect(stamped.streamSequence).toBe(1);
    expect(s.current()).toBe(1);
  });

  it('preserves the underlying delta payload (type, taskId, changes)', () => {
    const s = createTaskDeltaStreamSequence();
    const original: TaskDelta = {
      type: 'updated',
      taskId: 'wf-1/task-x',
      changes: { status: 'completed', execution: { exitCode: 0 } },
      taskStateVersion: 5,
      previousTaskStateVersion: 4,
    };
    const stamped = s.stamp(original);
    expect(stamped).toMatchObject({
      type: 'updated',
      taskId: 'wf-1/task-x',
      changes: { status: 'completed', execution: { exitCode: 0 } },
      taskStateVersion: 5,
      previousTaskStateVersion: 4,
    });
    expect(stamped.streamSequence).toBe(1);
  });

  it('snapshot watermark contract: current() after stamping reflects every delta', () => {
    const s = createTaskDeltaStreamSequence();
    s.stamp({ type: 'created', task: makeTask('a') });
    s.stamp({ type: 'created', task: makeTask('b') });
    s.stamp({ type: 'created', task: makeTask('c') });
    const snapshotWatermark = s.current();
    expect(snapshotWatermark).toBe(3);
    const nextStamp = s.stamp({ type: 'created', task: makeTask('d') });
    expect(nextStamp.streamSequence).toBe(snapshotWatermark + 1);
  });

  it('independent instances do not share state', () => {
    const a = createTaskDeltaStreamSequence();
    const b = createTaskDeltaStreamSequence();
    a.stamp({ type: 'created', task: makeTask('x') });
    a.stamp({ type: 'created', task: makeTask('y') });
    expect(a.current()).toBe(2);
    expect(b.current()).toBe(0);
  });
});
