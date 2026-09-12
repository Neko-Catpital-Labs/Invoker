/**
 * Regression test for the delete-workflow race described in
 * packages/data-store/src/__tests__/delete-workflow-race-fk-crash.test.ts:
 * a second owner's `preemptWorkflowExecution` (the first step of
 * `headlessDeleteWorkflow`) must not surface a raw FOREIGN KEY error when
 * the workflow was deleted by another owner between its DB read and its
 * per-task `task.cancelled` event write.
 */
import { describe, it, expect, vi } from 'vitest';
import { preemptWorkflowExecution } from '../headless-shared.js';
import type { HeadlessDeps } from '../headless.js';
import type { CommandService } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';

const noopLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(function () { return noopLogger; }),
};

function makeDeps(overrides: {
  cancelWorkflowError: { code: string; message: string };
  workflowExists: boolean;
}): HeadlessDeps {
  return {
    logger: noopLogger as any,
    orchestrator: {} as any,
    persistence: {
      loadWorkflow: vi.fn(() => (overrides.workflowExists ? { id: 'wf-1' } : undefined)),
    } as unknown as SQLiteAdapter,
    commandService: {
      preemptWorkflow: vi.fn(async () => ({ ok: false, error: overrides.cancelWorkflowError })),
    } as unknown as CommandService,
    executorRegistry: {} as any,
    messageBus: {} as any,
    repoRoot: '/fake/repo',
    invokerConfig: {} as any,
    initServices: vi.fn(async () => {}),
  };
}

describe('preemptWorkflowExecution race with a concurrent delete', () => {
  it('returns a clean empty result instead of throwing when the workflow is already gone', async () => {
    const deps = makeDeps({
      cancelWorkflowError: { code: 'CANCEL_WORKFLOW_FAILED', message: 'FOREIGN KEY constraint failed' },
      workflowExists: false,
    });

    const result = await preemptWorkflowExecution('wf-1', deps);

    expect(result).toEqual({ cancelled: [], runningCancelled: [] });
  });

  it('still throws a FOREIGN KEY error for a workflow that genuinely still exists', async () => {
    const deps = makeDeps({
      cancelWorkflowError: { code: 'CANCEL_WORKFLOW_FAILED', message: 'FOREIGN KEY constraint failed' },
      workflowExists: true,
    });

    await expect(preemptWorkflowExecution('wf-1', deps)).rejects.toThrow('FOREIGN KEY constraint failed');
  });

  it('still throws unrelated errors for a missing workflow', async () => {
    const deps = makeDeps({
      cancelWorkflowError: { code: 'CANCEL_WORKFLOW_FAILED', message: 'disk I/O error' },
      workflowExists: false,
    });

    await expect(preemptWorkflowExecution('wf-1', deps)).rejects.toThrow('disk I/O error');
  });
});
