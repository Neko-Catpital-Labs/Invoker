import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { CommandService, Orchestrator } from '@invoker/workflow-core';
import { headlessDeleteWorkflow } from '../headless-approve-delete.js';
import type { HeadlessDeps } from '../headless-shared.js';

/**
 * Simulates two competing owner processes sharing one SQLite DB file, as
 * happens when a headless `delete <workflowId>` delegation times out
 * (DEFAULT_DELEGATION_TIMEOUT_MS in packages/app/src/headless-delegation.ts)
 * and the client bootstraps a second owner that re-runs the same delete
 * while the first owner's delete is still completing.
 */
describe('delete-workflow race between two owner processes', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  async function setUpRacingOwners(workflowName: string) {
    const persistence = await SQLiteAdapter.create(':memory:');
    adapters.push(persistence);

    const ownerA = new Orchestrator({
      persistence: persistence as any,
      messageBus: new InMemoryBus(),
      maxConcurrency: 4,
    });
    const ownerB = new Orchestrator({
      persistence: persistence as any,
      messageBus: new InMemoryBus(),
      maxConcurrency: 4,
    });

    ownerA.loadPlan({ name: workflowName, tasks: [{ id: 't1', description: 'd', command: 'true' }] });
    const workflowId = ownerA.getAllTasks()[0]!.config.workflowId!;
    expect(workflowId).toBeTruthy();

    // Owner B learns about the workflow (e.g. from an earlier query/hydrate)
    // while the task still exists.
    ownerB.hydrateWorkflowFromDb(workflowId);

    // Owner A's delete completes fully — DB rows for the workflow and task are gone.
    ownerA.deleteWorkflow(workflowId);

    return { persistence, ownerB, workflowId };
  }

  it('a second owner racing cancelWorkflow (delete-workflow preemption) is a clean no-op', async () => {
    const { ownerB, workflowId } = await setUpRacingOwners('wf-race-cancel');
    const commandServiceB = new CommandService(ownerB);

    // Owner B still has the task cached from its earlier hydrate. Its
    // preemption step (cancelWorkflow, called first inside
    // headlessDeleteWorkflow's duplicate delete attempt) tries to log a
    // 'task.cancelled' event for a task that no longer exists in the DB.
    const envelope = {
      id: 'cmd-1',
      timestamp: new Date().toISOString(),
      source: 'headless' as const,
      target: 'workflow' as const,
      payload: { workflowId },
    };
    const result = await commandServiceB.cancelWorkflow(envelope);

    // cancelWorkflow itself is not part of the idempotent-delete guard, so a
    // duplicate cancel on a raced-away workflow still surfaces as a failed
    // command result — headlessDeleteWorkflow (tested below) is what turns
    // this into a clean success for the actual `delete` command.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/FOREIGN KEY constraint failed/);
    }
  });

  it('headlessDeleteWorkflow treats a raced duplicate delete as an already-satisfied success', async () => {
    const { persistence, ownerB, workflowId } = await setUpRacingOwners('wf-race-delete');
    const commandServiceB = new CommandService(ownerB);

    const noopLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => noopLogger),
    };
    const depsB: HeadlessDeps = {
      logger: noopLogger as any,
      orchestrator: ownerB,
      persistence,
      commandService: commandServiceB as any,
      executorRegistry: {} as any,
      messageBus: new InMemoryBus() as any,
      repoRoot: '/fake/repo',
      invokerConfig: {} as any,
      initServices: vi.fn(async () => {}),
      ownerTaskRunnerProvider: () => ({ closeWorkflowReview: vi.fn(async () => {}) } as any),
    };

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(headlessDeleteWorkflow(workflowId, depsB)).resolves.toBeUndefined();
      expect(stdout.mock.calls.some(([msg]) => String(msg).includes('already deleted'))).toBe(true);
    } finally {
      stdout.mockRestore();
    }

    // Safety invariant: the workflow must not be resurrected or corrupted by the raced attempt.
    expect(persistence.loadWorkflow(workflowId)).toBeUndefined();
  });
});
