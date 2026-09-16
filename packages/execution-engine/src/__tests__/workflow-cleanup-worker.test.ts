import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_WORKFLOW_CLEANUP_INTERVAL_MS,
  WORKFLOW_CLEANUP_WORKER_KIND,
  createWorkflowCleanupWorker,
  registerWorkflowCleanupWorker,
} from '../workers/workflow-cleanup-worker.js';
import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

describe('workflow cleanup worker', () => {
  it('deletes completed and closed workflows, leaving other statuses alone', async () => {
    const deleteWorkflow = vi.fn();
    const worker = createWorkflowCleanupWorker({
      logger,
      store: {
        listWorkflows: () => [
          { id: 'completed', status: 'completed' },
          { id: 'closed', status: 'closed' },
          { id: 'failed', status: 'failed' },
          { id: 'running', status: 'running' },
        ],
      },
      deleteWorkflow,
      tickOnStart: false,
    });

    await worker.tick();

    expect(deleteWorkflow.mock.calls).toEqual([['completed'], ['closed']]);
  });

  it('continues deleting later candidates when one deletion fails', async () => {
    const deleteWorkflow = vi.fn((workflowId: string) => {
      if (workflowId === 'bad') throw new Error('delete failed');
    });
    const worker = createWorkflowCleanupWorker({
      logger,
      store: { listWorkflows: () => [{ id: 'bad', status: 'completed' }, { id: 'good', status: 'closed' }] },
      deleteWorkflow,
      tickOnStart: false,
    });

    await worker.tick();

    expect(deleteWorkflow.mock.calls).toEqual([['bad'], ['good']]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to delete workflow bad'),
      expect.objectContaining({ workflowId: 'bad' }),
    );
  });

  it('polls again after five minutes by default', async () => {
    vi.useFakeTimers();
    const listWorkflows = vi.fn(() => []);
    const worker = createWorkflowCleanupWorker({
      logger,
      store: { listWorkflows },
      deleteWorkflow: vi.fn(),
      tickOnStart: false,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(DEFAULT_WORKFLOW_CLEANUP_INTERVAL_MS - 1);
    expect(listWorkflows).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(listWorkflows).toHaveBeenCalledTimes(1);
    await worker.stop();
    vi.useRealTimers();
  });

  it('registers a built-in runtime under the cleanup kind', () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registerWorkflowCleanupWorker(registry);
    const runtime = registry.get(WORKFLOW_CLEANUP_WORKER_KIND)?.factory({
      store: { listWorkflows: () => [] } as WorkerRuntimeDependencies['store'],
      workflowCleanup: { listWorkflows: () => [] },
      deleteWorkflow: vi.fn(),
      submitter: {} as WorkerRuntimeDependencies['submitter'],
      logger,
    });

    expect(runtime?.identity.kind).toBe(WORKFLOW_CLEANUP_WORKER_KIND);
  });
});
