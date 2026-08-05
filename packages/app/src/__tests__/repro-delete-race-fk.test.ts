import { describe, expect, it } from 'vitest';
import { makeEnvelope } from '@invoker/contracts';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { CommandService, Orchestrator, type PlanDefinition } from '@invoker/workflow-core';
import type { HeadlessDeps } from '../headless-shared.js';
import { preemptWorkflowExecution } from '../headless-shared.js';

function buildSingleTaskPlan(name: string, taskId: string): PlanDefinition {
  return {
    name,
    tasks: [
      {
        id: taskId,
        description: taskId,
        command: `echo ${taskId}`,
      },
    ],
  };
}

/**
 * Simulates the "second competing owner" race from headless-delegation.ts:
 * a delegated `delete <workflowId>` times out client-side, the client
 * bootstraps a second owner process, and that second owner re-runs the same
 * delete after the first owner's delete has already succeeded. Each owner is
 * its own OS process with its own Orchestrator/CommandService instance, both
 * pointed at the same on-disk DB.
 */
describe('delete-workflow race: duplicate delete on an already-deleted workflow', () => {
  it('does not surface a raw FOREIGN KEY error and completes as a clean no-op', async () => {
    const persistence = await SQLiteAdapter.create(':memory:');

    // First owner: creates and will fully delete the workflow.
    const orchestratorA = new Orchestrator({
      persistence: persistence as any,
      messageBus: new InMemoryBus(),
      maxConcurrency: 4,
    });
    const commandServiceA = new CommandService(orchestratorA);
    orchestratorA.loadPlan(buildSingleTaskPlan('wf-race', 'task-race'));

    const realTaskId = persistence.getAllTaskIds().find((id) => !id.startsWith('__merge__'))!;
    const workflowId = persistence.loadTask(realTaskId)!.config.workflowId as string;
    expect(workflowId).toBeTruthy();

    // Second owner bootstraps and caches this workflow's tasks while they
    // still exist, mimicking a process that spun up around the same time as
    // the first owner's delete.
    const orchestratorB = new Orchestrator({
      persistence: persistence as any,
      messageBus: new InMemoryBus(),
      maxConcurrency: 4,
    });
    const commandServiceB = new CommandService(orchestratorB);
    orchestratorB.syncFromDb(workflowId);
    expect(orchestratorB.getAllTasks().length).toBeGreaterThan(0);

    // First owner's delete completes successfully (the real DB delete path).
    const resultA = await commandServiceA.deleteWorkflow(
      makeEnvelope('delete-workflow', 'headless', 'workflow', { workflowId }),
    );
    expect(resultA.ok).toBe(true);
    expect(persistence.loadTasks(workflowId)).toHaveLength(0);

    // Second owner replays headlessDeleteWorkflow's sequence against its
    // stale in-memory cache: preempt (cancel-workflow) then delete-workflow.
    const depsB = { commandService: commandServiceB } as unknown as HeadlessDeps;

    const preemptResult = await preemptWorkflowExecution(workflowId, depsB);
    expect(preemptResult).toEqual({ cancelled: [], runningCancelled: [] });

    const resultB = await commandServiceB.deleteWorkflow(
      makeEnvelope('delete-workflow', 'headless', 'workflow', { workflowId }),
    );
    expect(resultB.ok).toBe(true);
  });
});
