import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
import { resolveTaskConfig, type TaskState } from '@invoker/workflow-core';

const WORKFLOW_ID = 'wf-priority-dispatch';

function makeWorkflow(): Workflow {
  const now = new Date('2026-09-04T00:00:00.000Z').toISOString();
  return {
    id: WORKFLOW_ID,
    name: 'priority dispatch test',
    status: 'running',
    createdAt: now,
    updatedAt: now,
  };
}

function makeTask(id: string, selectedAttemptId: string): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-09-04T00:00:00.000Z'),
    taskStateVersion: 1,
    config: resolveTaskConfig({ workflowId: WORKFLOW_ID }),
    execution: { generation: 1, selectedAttemptId },
  };
}

describe('task_launch_dispatch priority ordering', () => {
  let adapter: SQLiteAdapter | undefined;
  let cleanupDir: string | undefined;

  afterEach(() => {
    adapter?.close();
    adapter = undefined;
    if (cleanupDir) {
      rmSync(cleanupDir, { recursive: true, force: true });
      cleanupDir = undefined;
    }
  });

  async function createAdapter(): Promise<SQLiteAdapter> {
    cleanupDir = mkdtempSync(join(tmpdir(), 'invoker-priority-dispatch-'));
    return SQLiteAdapter.create(join(cleanupDir, 'invoker.db'), { ownerCapability: true });
  }

  it('leases a priority-1 task before a priority-4 task queued earlier', async () => {
    adapter = await createAdapter();
    adapter.saveWorkflow(makeWorkflow());
    adapter.saveTask(WORKFLOW_ID, makeTask('t-worker', 't-worker-attempt-1'));
    adapter.saveTask(WORKFLOW_ID, makeTask('t-human', 't-human-attempt-1'));

    adapter.enqueueLaunchDispatch({
      taskId: 't-worker',
      attemptId: 't-worker-attempt-1',
      workflowId: WORKFLOW_ID,
      generation: 1,
      priority: 4,
    });
    adapter.enqueueLaunchDispatch({
      taskId: 't-human',
      attemptId: 't-human-attempt-1',
      workflowId: WORKFLOW_ID,
      generation: 1,
      priority: 1,
    });

    const leased = adapter.claimLaunchDispatchAtomic({ ownerId: 'test-owner' });

    expect(leased?.taskId).toBe('t-human');
    expect(leased?.priority).toBe(1);
  });

  it('falls back to FIFO (id ascending) among equal priorities', async () => {
    adapter = await createAdapter();
    adapter.saveWorkflow(makeWorkflow());
    adapter.saveTask(WORKFLOW_ID, makeTask('t-first', 't-first-attempt-1'));
    adapter.saveTask(WORKFLOW_ID, makeTask('t-second', 't-second-attempt-1'));

    adapter.enqueueLaunchDispatch({
      taskId: 't-first',
      attemptId: 't-first-attempt-1',
      workflowId: WORKFLOW_ID,
      generation: 1,
      priority: 2,
    });
    adapter.enqueueLaunchDispatch({
      taskId: 't-second',
      attemptId: 't-second-attempt-1',
      workflowId: WORKFLOW_ID,
      generation: 1,
      priority: 2,
    });

    const leased = adapter.claimLaunchDispatchAtomic({ ownerId: 'test-owner' });

    expect(leased?.taskId).toBe('t-first');
  });

  it('defaults to priority 2 when the caller omits it', async () => {
    adapter = await createAdapter();
    adapter.saveWorkflow(makeWorkflow());
    adapter.saveTask(WORKFLOW_ID, makeTask('t-default', 't-default-attempt-1'));

    const dispatch = adapter.enqueueLaunchDispatch({
      taskId: 't-default',
      attemptId: 't-default-attempt-1',
      workflowId: WORKFLOW_ID,
      generation: 1,
    });

    expect(dispatch.priority).toBe(2);
  });
});
