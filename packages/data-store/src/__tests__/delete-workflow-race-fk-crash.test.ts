/**
 * Documents the raw mechanism behind the delete-workflow race fixed in
 * `preemptWorkflowExecution` (packages/app/src/headless-shared.ts): a second
 * owner racing a `delete <workflowId>` against a first owner's in-flight
 * delete of the same workflow can hit a raw FOREIGN KEY constraint error at
 * the Orchestrator layer.
 *
 * `headlessDeleteWorkflow` (packages/app/src/headless-approve-delete.ts)
 * starts by calling `preemptWorkflowExecution`, which delegates to
 * `CommandService.cancelWorkflow` -> `Orchestrator.cancelWorkflow` ->
 * `cancelWorkflowImpl`. That function reads the workflow's tasks from the DB
 * (`refreshWorkflowFromDb`), then loops over them writing a `task.cancelled`
 * event per task (`persistence.logEvent`). If another owner process deletes
 * the workflow (and its tasks) between that read and the event write, the
 * `events.task_id -> tasks(id)` foreign key rejects the insert with a raw
 * "FOREIGN KEY constraint failed" error that is not an `OrchestratorError`,
 * so `CommandService.executeCommand` cannot map it to `WORKFLOW_NOT_FOUND`.
 *
 * `Orchestrator.cancelWorkflow` still throws this raw error by design — the
 * fix lives one layer up, in `preemptWorkflowExecution`, which now checks
 * for exactly this shape (FK message + workflow confirmed missing) and
 * treats it as an already-satisfied cancel instead of propagating it. See
 * `packages/app/src/__tests__/headless-preempt-workflow-race.test.ts` for
 * the regression test on that guard.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '@invoker/workflow-core';
import type { OrchestratorMessageBus } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';

class NoopBus implements OrchestratorMessageBus {
  publish(): void {}
  subscribe(): () => void {
    return () => undefined;
  }
}

describe('racing delete of the same workflow across two owners', () => {
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

  it('cancelWorkflow (the first step of headlessDeleteWorkflow) throws a raw FK error when the workflow is deleted mid-flight', async () => {
    cleanupDir = mkdtempSync(join(tmpdir(), 'invoker-delete-race-fk-'));
    adapter = await SQLiteAdapter.create(join(cleanupDir, 'invoker.db'), { ownerCapability: true });

    const orchestrator = new Orchestrator({
      persistence: adapter,
      messageBus: new NoopBus(),
      maxConcurrency: 8,
      resolveRepoDefaultBranch: () => 'main',
    });

    orchestrator.loadPlan({
      name: 'race-target',
      baseBranch: 'master',
      repoUrl: 'memory://test-repo',
      featureBranch: 'feature/race-target',
      tasks: [{ id: 'leaf', description: 'target leaf' }],
    });
    const workflowId = orchestrator.getAllTasks()
      .find((t) => !t.config.isMergeNode)!.config.workflowId!;

    // logEvent is the exact call cancelWorkflowImpl makes per task after it
    // has already read the (soon to be stale) task list. Simulate the other
    // owner's delete completing in the gap between that read and this write
    // by deleting the workflow for real, on the same underlying DB, the
    // first time cancelWorkflowImpl tries to log a cancellation event.
    const realLogEvent = adapter.logEvent.bind(adapter);
    const logEventSpy = vi.spyOn(adapter, 'logEvent');
    logEventSpy.mockImplementationOnce((...args) => {
      adapter!.deleteWorkflow(workflowId);
      return realLogEvent(...args);
    });

    let caught: unknown;
    try {
      orchestrator.cancelWorkflow(workflowId);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('FOREIGN KEY constraint failed');
  });
});
