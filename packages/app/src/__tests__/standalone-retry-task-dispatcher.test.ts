import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import {
  AUTO_FIX_BARE_RETRY_CHANNEL,
  createAutoFixAttemptLedger,
  createAutoFixRecoveryTick,
} from '@invoker/execution-engine';
import { CommandService, Orchestrator } from '@invoker/workflow-core';
import { InMemoryBus } from '@invoker/test-kit';

import { PersistedWorkflowMutationCoordinator } from '../persisted-workflow-mutation-coordinator.js';
import { executeStandaloneRetryTaskMutation } from '../standalone-retry-task-dispatcher.js';
import { submitWorkflowMutationOrAcknowledgeDeleted } from '../workflow-mutation-submit.js';
import type { WorkflowMutationPriority } from '../workflow-mutation-coordinator.js';

function makeLogger() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

async function waitFor(condition: () => boolean, attempts: number = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('standalone auto-fix bare retry dispatcher', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  it('repro: owner worker bare retry completes through invoker:retry-task instead of missing a dispatcher', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);
    const logger = makeLogger();
    const orchestrator = new Orchestrator({
      persistence: adapter,
      messageBus: new InMemoryBus(),
      maxConcurrency: 1,
    } as never);
    orchestrator.loadPlan({
      name: 'standalone bare retry repro',
      onFinish: 'none',
      tasks: [{ id: 'build', description: 'build', command: 'pnpm build' }],
    });
    const workflowId = orchestrator.getWorkflowIds()[0]!;
    const taskId = `${workflowId}/build`;
    const [runningTask] = orchestrator.startExecution();
    expect(runningTask?.id).toBe(taskId);
    orchestrator.handleWorkerResponse({
      requestId: 'req-1',
      actionId: taskId,
      attemptId: runningTask?.execution.selectedAttemptId,
      executionGeneration: runningTask?.execution.generation ?? 0,
      status: 'failed',
      outputs: { exitCode: 1, error: 'transient failure before auto-fix' },
    });
    expect(orchestrator.getTask(taskId)?.status).toBe('failed');

    const commandService = new CommandService(orchestrator);
    const workflowMutationDispatcher = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    workflowMutationDispatcher.set(AUTO_FIX_BARE_RETRY_CHANNEL, async (...retryArgs: unknown[]) => {
      await executeStandaloneRetryTaskMutation(retryArgs[0], {
        commandService,
        orchestrator,
        taskExecutor: {} as never,
        logger,
        context: 'test.standalone.retry-task',
      });
      return { ok: true };
    });
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'owner-1',
      async (channel, args) => {
        const handler = workflowMutationDispatcher.get(channel);
        if (!handler) {
          throw new Error(`No workflow mutation dispatcher registered for ${channel}`);
        }
        return handler(...args);
      },
      { logger },
    );
    const submit = (
      submittedWorkflowId: string,
      priority: WorkflowMutationPriority,
      channel: string,
      args: unknown[],
      options?: { deferDrain?: boolean },
    ): number => {
      if (!workflowMutationDispatcher.has(channel)) {
        throw new Error(`No workflow mutation dispatcher registered for ${channel}`);
      }
      return submitWorkflowMutationOrAcknowledgeDeleted(submittedWorkflowId, priority, channel, args, {
        coordinator,
        workflowExists: (id) => Boolean(adapter.loadWorkflow(id)),
        logger,
        deferDrain: options?.deferDrain,
      }).intentId;
    };
    const tick = createAutoFixRecoveryTick({
      store: adapter,
      submitter: { submit },
      logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 1,
      getAutoFixAgent: () => 'codex',
    });

    await expect(tick({ reason: 'poll' } as never)).resolves.toBeUndefined();
    await waitFor(() => adapter.listWorkflowMutationIntents(workflowId, ['completed']).length === 1);

    const intents = adapter.listWorkflowMutationIntents(workflowId);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.error ?? null).toBeNull();
    expect(intents[0]).toMatchObject({
      channel: AUTO_FIX_BARE_RETRY_CHANNEL,
      status: 'completed',
    });
    expect(adapter.listWorkflowMutationIntents(workflowId, ['failed'])).toEqual([]);
    expect(orchestrator.getTask(taskId)?.status).not.toBe('failed');
  });
});
