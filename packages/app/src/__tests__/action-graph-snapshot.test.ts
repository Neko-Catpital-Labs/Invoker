import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator, type Attempt, type TaskState } from '@invoker/workflow-core';
import {
  buildCurrentActionGraphSnapshot,
  createCachedActionGraphSnapshotReader,
} from '../action-graph-snapshot.js';
import type { InvokerConfig } from '../config.js';

describe('buildCurrentActionGraphSnapshot', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  it('does not emit a failed blocker when selected_attempt_id targets a failed attempt but a newer active attempt exists', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);

    const workflowId = 'wf-stale';
    const taskId = 'wf-stale/verify';
    adapter.saveWorkflow({
      id: workflowId,
      name: 'Remove Running Sidebar And Workers Screen Title',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const olderCreatedAt = new Date('2026-07-09T05:38:02.000Z');
    const newerCreatedAt = new Date('2026-07-09T05:51:12.808Z');

    const failed: Attempt = {
      id: `${taskId}-aOLD`,
      nodeId: taskId,
      queuePriority: 0,
      status: 'failed',
      upstreamAttemptIds: [],
      error: 'Cancelled by user (workflow)',
      completedAt: new Date('2026-07-09T05:51:12.761Z'),
      startedAt: new Date('2026-07-09T05:43:54.107Z'),
      lastHeartbeatAt: new Date('2026-07-09T05:43:54.107Z'),
      createdAt: olderCreatedAt,
    };
    const newerPending: Attempt = {
      id: `${taskId}-aNEW`,
      nodeId: taskId,
      queuePriority: 0,
      status: 'pending',
      upstreamAttemptIds: [],
      supersedesAttemptId: failed.id,
      createdAt: newerCreatedAt,
    };
    const task: TaskState = {
      id: taskId,
      description: 'Verify sidebar and workers title removal',
      status: 'running',
      dependencies: [],
      createdAt: olderCreatedAt,
      config: { workflowId },
      execution: {
        startedAt: failed.startedAt,
        lastHeartbeatAt: failed.lastHeartbeatAt,
      },
      taskStateVersion: 1,
    };
    adapter.saveTask(workflowId, task);
    adapter.saveAttempt(failed);
    adapter.saveAttempt(newerPending);
    // Production shape: selected_attempt_id lags on the failed attempt.
    adapter.updateTask(taskId, { execution: { selectedAttemptId: failed.id } });

    const orchestrator = new Orchestrator({
      persistence: adapter as any,
      messageBus: new InMemoryBus(),
      maxConcurrency: 1,
    });

    const invokerConfig: InvokerConfig = {};
    const snapshot = buildCurrentActionGraphSnapshot({
      orchestrator,
      persistence: adapter,
      invokerConfig,
    });

    const failedBlocker = snapshot.nodes.find(
      (node) => node.id === `blocker:${taskId}:error` && node.status === 'failed',
    );
    expect(failedBlocker).toBeUndefined();

    // Pointer stays as-persisted; the projection is read-only.
    const reloaded = adapter.loadTask(taskId)!;
    expect(reloaded.execution.selectedAttemptId).toBe(failed.id);
    expect(reloaded.execution.error).toBeUndefined();
  });

  it.fails('reuses a fresh action graph snapshot for refocus-burst reads', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-cache',
      name: 'Cached action graph',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    adapter.saveTask('wf-cache', {
      id: 'wf-cache/task',
      description: 'Cached task',
      status: 'completed',
      dependencies: [],
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      config: { workflowId: 'wf-cache' },
      execution: { exitCode: 0, completedAt: new Date('2026-07-01T00:00:01.000Z') },
      taskStateVersion: 1,
    });

    const orchestrator = new Orchestrator({
      persistence: adapter as any,
      messageBus: new InMemoryBus(),
      maxConcurrency: 1,
    });
    const loadSnapshot = vi.spyOn(adapter, 'loadWorkflowTaskSnapshot');
    let now = 1000;
    const read = createCachedActionGraphSnapshotReader({
      getOrchestrator: () => orchestrator,
      persistence: adapter,
      invokerConfig: {},
      ttlMs: 1000,
      now: () => now,
    });

    const first = read();
    const second = read();
    expect(second).toBe(first);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    now += 1001;
    const third = read();
    expect(third).not.toBe(first);
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });
});
