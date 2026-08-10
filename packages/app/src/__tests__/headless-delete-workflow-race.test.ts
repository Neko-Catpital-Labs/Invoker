/**
 * Regression test for the delete-workflow race described in
 * packages/data-store/src/__tests__/delete-workflow-race-fk-crash.test.ts.
 *
 * headlessDeleteWorkflow makes two calls that can race a concurrent delete:
 *  1. preemptWorkflowExecution (cancel) — already guarded, see
 *     headless-preempt-workflow-race.test.ts.
 *  2. commandService.deleteWorkflow — NOT guarded: any raw FOREIGN KEY
 *     constraint failure from a racing owner's concurrent write is thrown
 *     verbatim even though the workflow row was already deleted.
 */
import { describe, it, expect, vi } from 'vitest';
import { headlessDeleteWorkflow } from '../headless-approve-delete.js';
import type { HeadlessDeps } from '../headless.js';
import type { CommandService } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { TaskRunner } from '@invoker/execution-engine';

const noopLogger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(function () { return noopLogger; }),
};

const stubTaskRunner = {
  closeWorkflowReview: vi.fn(async () => {}),
} as unknown as TaskRunner;

function makeDeps(overrides: {
  deleteWorkflowError: { code: string; message: string };
  workflowExists: boolean;
}): HeadlessDeps {
  return {
    logger: noopLogger as any,
    orchestrator: {} as any,
    persistence: {
      loadWorkflow: vi.fn(() => (overrides.workflowExists ? { id: 'wf-1' } : undefined)),
    } as unknown as SQLiteAdapter,
    commandService: {
      deleteWorkflow: vi.fn(async () => ({ ok: false, error: overrides.deleteWorkflowError })),
    } as unknown as CommandService,
    executorRegistry: {} as any,
    messageBus: {} as any,
    repoRoot: '/fake/repo',
    invokerConfig: {} as any,
    initServices: vi.fn(async () => {}),
    ownerTaskRunnerProvider: () => stubTaskRunner,
    preemptWorkflowExecution: vi.fn(async () => ({ cancelled: [], runningCancelled: [] })),
  };
}

describe('headlessDeleteWorkflow race with a concurrent delete', () => {
  it('resolves cleanly instead of throwing when the workflow is already gone', async () => {
    const deps = makeDeps({
      deleteWorkflowError: { code: 'DELETE_WORKFLOW_FAILED', message: 'FOREIGN KEY constraint failed' },
      workflowExists: false,
    });

    await expect(headlessDeleteWorkflow('wf-1', deps)).resolves.toBeUndefined();
  });

  it('still throws a FOREIGN KEY error for a workflow that genuinely still exists', async () => {
    const deps = makeDeps({
      deleteWorkflowError: { code: 'DELETE_WORKFLOW_FAILED', message: 'FOREIGN KEY constraint failed' },
      workflowExists: true,
    });

    await expect(headlessDeleteWorkflow('wf-1', deps)).rejects.toThrow('FOREIGN KEY constraint failed');
  });

  it('still throws unrelated errors for a missing workflow', async () => {
    const deps = makeDeps({
      deleteWorkflowError: { code: 'DELETE_WORKFLOW_FAILED', message: 'disk I/O error' },
      workflowExists: false,
    });

    await expect(headlessDeleteWorkflow('wf-1', deps)).rejects.toThrow('disk I/O error');
  });
});
