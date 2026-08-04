import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator, CommandService } from '@invoker/workflow-core';
import { headlessDeleteWorkflow } from '../headless-approve-delete.js';
import type { HeadlessDeps } from '../headless-shared.js';

function makeDeps(orchestrator: Orchestrator, persistence: SQLiteAdapter, commandService: CommandService): HeadlessDeps {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => noopLogger),
  };
  return {
    logger: noopLogger as any,
    orchestrator,
    persistence,
    commandService,
    executorRegistry: {} as any,
    messageBus: new InMemoryBus() as any,
    repoRoot: '/fake/repo',
    invokerConfig: {} as any,
    initServices: vi.fn(async () => {}),
    ownerTaskRunnerProvider: () => ({ closeWorkflowReview: async () => {} } as any),
  } as HeadlessDeps;
}

describe('headlessDeleteWorkflow racing a duplicate delete on an already-deleted workflow', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  it('fixed: a duplicate delete-workflow that races a completed delete is a clean no-op, not a raw FOREIGN KEY crash', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-race',
      name: 'wf-race',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    adapter.saveTask('wf-race', {
      id: 'wf-race/task-a',
      description: 'task a',
      status: 'running',
      dependencies: [],
      createdAt: new Date(),
      config: { workflowId: 'wf-race' },
      execution: {},
      taskStateVersion: 1,
    } as any);

    // Owner A: the delegate target the client originally reached. It will
    // complete the delete first (simulating the delegation timeout firing
    // client-side just before owner A's delete actually lands).
    const ownerAOrchestrator = new Orchestrator({ persistence: adapter as any, messageBus: new InMemoryBus(), maxConcurrency: 1 });
    const ownerACommandService = new CommandService(ownerAOrchestrator);

    // Owner B: a second, competing owner the client bootstrapped after the
    // delegation timeout. It loaded workflow/task state into memory BEFORE
    // owner A's delete committed, so its in-memory view is stale.
    const ownerBOrchestrator = new Orchestrator({ persistence: adapter as any, messageBus: new InMemoryBus(), maxConcurrency: 1 });
    ownerBOrchestrator.syncAllFromDb();
    const ownerBCommandService = new CommandService(ownerBOrchestrator);
    const ownerBDeps = makeDeps(ownerBOrchestrator, adapter, ownerBCommandService);

    // Owner A's delete completes first.
    await headlessDeleteWorkflow('wf-race', makeDeps(ownerAOrchestrator, adapter, ownerACommandService));
    expect(adapter.loadWorkflow('wf-race')).toBeUndefined();

    // Owner B now processes the same `delete wf-race` command against its
    // stale in-memory state. This must resolve cleanly, not throw a raw
    // FOREIGN KEY constraint failed error.
    await expect(headlessDeleteWorkflow('wf-race', ownerBDeps)).resolves.toBeUndefined();

    // The already-missing workflow must not have been recreated or left in
    // a corrupted state by the raced duplicate delete.
    expect(adapter.loadWorkflow('wf-race')).toBeUndefined();
    expect(adapter.loadTasks('wf-race')).toHaveLength(0);
  });

  it('still throws for a delete failure unrelated to a raced deletion', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    adapter.saveWorkflow({
      id: 'wf-real-failure',
      name: 'wf-real-failure',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const orchestrator = new Orchestrator({ persistence: adapter as any, messageBus: new InMemoryBus(), maxConcurrency: 1 });
    const commandService = new CommandService(orchestrator);
    const deps = makeDeps(orchestrator, adapter, commandService);
    deps.commandService.cancelWorkflow = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'CANCEL_WORKFLOW_FAILED', message: 'FOREIGN KEY constraint failed' },
    }));

    await expect(headlessDeleteWorkflow('wf-real-failure', deps)).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});
