import { describe, it, expect } from 'vitest';
import type { TaskDelta, TaskState } from '@invoker/workflow-core';
import { applyDelta, TaskSnapshotCache } from '../delta-merge.js';
import { WorkflowRollupProjection } from '../workflow-rollup-projection.js';
import { seedTaskCachesFromSnapshot } from '../viewer-cache-hydration.js';

function ownerTask(version: number): TaskState {
  return {
    id: 'wf-1/task-1',
    description: 'owner task',
    status: 'running',
    dependencies: [],
    createdAt: new Date('2026-01-01').toISOString(),
    config: {},
    execution: {},
    taskStateVersion: version,
  } as unknown as TaskState;
}

function ownerUpdateDelta(): TaskDelta {
  return {
    type: 'updated',
    taskId: 'wf-1/task-1',
    previousTaskStateVersion: 1,
    taskStateVersion: 2,
    changes: { status: 'completed' },
  } as unknown as TaskDelta;
}

describe('detached viewer cache hydration', () => {
  it('repro: an empty viewer cache quarantines (drops) an owner task update', () => {
    // A detached viewer backed by an empty in-memory DB has an empty cache.
    const cache = new TaskSnapshotCache();
    const { quarantined, accepted } = applyDelta(ownerUpdateDelta(), cache);
    expect(accepted).toBe(false);
    expect(quarantined).toEqual(['wf-1/task-1']); // the live update is lost
  });

  it('hydrating the caches from the owner snapshot lets the same update apply', () => {
    const lastKnownTaskStates = new TaskSnapshotCache();
    const workflowRollupProjection = new WorkflowRollupProjection();
    seedTaskCachesFromSnapshot([ownerTask(1)], { lastKnownTaskStates, workflowRollupProjection });
    const { quarantined, accepted } = applyDelta(ownerUpdateDelta(), lastKnownTaskStates);
    expect(quarantined).toEqual([]);
    expect(accepted).toBe(true);
    // The cache stores the JSON snapshot string; verify the task was actually mutated.
    const merged = JSON.parse(lastKnownTaskStates.get('wf-1/task-1') ?? '{}') as { status?: string; taskStateVersion?: number };
    expect(merged.status).toBe('completed');
    expect(merged.taskStateVersion).toBe(2);
  });
});
