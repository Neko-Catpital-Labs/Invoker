import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import {
  AUTO_APPROVE_COMMAND_CHANNEL,
  createAutoApproveTick,
  createRequeueAttemptLedger,
  createRequeueRecoveryTick,
  REQUEUE_ESCALATE_CHANNEL,
} from '@invoker/execution-engine';
import { CommandService, Orchestrator } from '@invoker/workflow-core';
import { InMemoryBus } from '@invoker/test-kit';

import { executeApproveTaskMutation } from '../standalone-approve-task-dispatcher.js';
import { executeRequeueEscalateMutation } from '../standalone-requeue-escalate-dispatcher.js';
import { PersistedWorkflowMutationCoordinator } from '../persisted-workflow-mutation-coordinator.js';
import { submitWorkflowMutationOrAcknowledgeDeleted } from '../workflow-mutation-submit.js';
import type { WorkflowMutationPriority } from '../workflow-mutation-coordinator.js';

// Incident 2026-08-06/07: three separate worker-submitted mutation channels
// (invoker:retry-task, invoker:approve, invoker:requeue-escalate) have each
// gone unregistered in `workflowMutationDispatcher` at one point or another,
// each time silently failing every intent submitted on that channel instead
// of crashing or logging loudly (see `PersistedWorkflowMutationCoordinator`'s
// `executeIntent`, which catches the dispatch throw and marks the intent
// `failed`). This file proves that production failure mode end-to-end for
// `invoker:approve` and `invoker:requeue-escalate` — real SQLite persistence,
// real Orchestrator, real worker tick functions, real coordinator — then
// proves the fix by re-running the identical scenario with the real
// production handler wired in.

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

type Dispatcher = Map<string, (...args: unknown[]) => Promise<unknown>>;

function makeCoordinatorAndSubmit(
  adapter: SQLiteAdapter,
  dispatcher: Dispatcher,
  logger: ReturnType<typeof makeLogger>,
) {
  const coordinator = new PersistedWorkflowMutationCoordinator(
    adapter,
    'owner-1',
    async (channel, args) => {
      const handler = dispatcher.get(channel);
      if (!handler) {
        throw new Error(`No workflow mutation dispatcher registered for ${channel}`);
      }
      return handler(...args);
    },
    { logger },
  );
  const submit = (
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number =>
    submitWorkflowMutationOrAcknowledgeDeleted(workflowId, priority, channel, args, {
      coordinator,
      workflowExists: (id) => Boolean(adapter.loadWorkflow(id)),
      logger,
      deferDrain: options?.deferDrain,
    }).intentId;
  return { coordinator, submit };
}

describe('worker-submitted mutation channel repro', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  describe('invoker:approve (auto-approve worker)', () => {
    async function setUpAwaitingApprovalTask() {
      const adapter = await SQLiteAdapter.create(':memory:');
      adapters.push(adapter);
      const orchestrator = new Orchestrator({
        persistence: adapter,
        messageBus: new InMemoryBus(),
        maxConcurrency: 1,
      } as never);
      orchestrator.loadPlan({
        name: 'auto-approve repro',
        onFinish: 'none',
        tasks: [{ id: 'build', description: 'build', command: 'pnpm build' }],
      });
      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const taskId = `${workflowId}/build`;
      orchestrator.startExecution();
      orchestrator.setFixAwaitingApproval(taskId, 'transient failure before auto-approve');
      expect(orchestrator.getTask(taskId)?.status).toBe('awaiting_approval');
      expect(orchestrator.getTask(taskId)?.execution.pendingFixError).toBe('transient failure before auto-approve');
      return { adapter, orchestrator, workflowId, taskId };
    }

    it('repro: the auto-approve worker tick fails the intent when invoker:approve has no dispatcher', async () => {
      const { adapter, orchestrator, workflowId, taskId } = await setUpAwaitingApprovalTask();
      const logger = makeLogger();
      const dispatcher: Dispatcher = new Map(); // deliberately missing invoker:approve — matches an unregistered channel
      const { submit } = makeCoordinatorAndSubmit(adapter, dispatcher, logger);

      const tick = createAutoApproveTick({
        store: adapter,
        submitter: { submit },
        logger,
        enabled: true,
      });

      await expect(tick({ reason: 'poll' } as never)).resolves.toBeUndefined();
      await waitFor(() => adapter.listWorkflowMutationIntents(workflowId, ['failed']).length === 1);

      const failed = adapter.listWorkflowMutationIntents(workflowId, ['failed']);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ channel: AUTO_APPROVE_COMMAND_CHANNEL });
      expect(failed[0]?.error ?? '').toContain(`No workflow mutation dispatcher registered for ${AUTO_APPROVE_COMMAND_CHANNEL}`);
      // The task is left stuck awaiting approval forever — the production symptom of this bug class.
      expect(orchestrator.getTask(taskId)?.status).toBe('awaiting_approval');
    });

    it('fix: with the real handler registered, the same tick completes the approval', async () => {
      const { adapter, orchestrator, workflowId, taskId } = await setUpAwaitingApprovalTask();
      const logger = makeLogger();
      const commandService = new CommandService(orchestrator);
      const dispatcher: Dispatcher = new Map();
      dispatcher.set(AUTO_APPROVE_COMMAND_CHANNEL, async (...args: unknown[]) => {
        await executeApproveTaskMutation(args[0], {
          commandService,
          orchestrator,
          taskExecutor: { commitApprovedFix: async () => {} } as never,
          logger,
          context: 'test.approve',
        });
        return { ok: true };
      });
      const { submit } = makeCoordinatorAndSubmit(adapter, dispatcher, logger);

      const tick = createAutoApproveTick({
        store: adapter,
        submitter: { submit },
        logger,
        enabled: true,
      });

      await expect(tick({ reason: 'poll' } as never)).resolves.toBeUndefined();
      await waitFor(() => adapter.listWorkflowMutationIntents(workflowId, ['completed']).length === 1);

      const intents = adapter.listWorkflowMutationIntents(workflowId);
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ channel: AUTO_APPROVE_COMMAND_CHANNEL, status: 'completed' });
      expect(adapter.listWorkflowMutationIntents(workflowId, ['failed'])).toEqual([]);
      expect(orchestrator.getTask(taskId)?.status).not.toBe('awaiting_approval');
    });
  });

  describe('invoker:requeue-escalate (requeue worker)', () => {
    async function setUpStalledLivenessTask() {
      const adapter = await SQLiteAdapter.create(':memory:');
      adapters.push(adapter);
      const orchestrator = new Orchestrator({
        persistence: adapter,
        messageBus: new InMemoryBus(),
        maxConcurrency: 1,
      } as never);
      orchestrator.loadPlan({
        name: 'requeue-escalate repro',
        onFinish: 'none',
        tasks: [{ id: 'build', description: 'build', command: 'pnpm build' }],
      });
      const workflowId = orchestrator.getWorkflowIds()[0]!;
      const taskId = `${workflowId}/build`;
      const [runningTask] = orchestrator.startExecution();
      orchestrator.handleWorkerResponse({
        requestId: 'req-1',
        actionId: taskId,
        attemptId: runningTask?.execution.selectedAttemptId,
        executionGeneration: runningTask?.execution.generation ?? 0,
        status: 'failed',
        outputs: { exitCode: 1, error: 'executing-stall timeout', failureClass: 'liveness_stall' },
      });
      expect(orchestrator.getTask(taskId)?.status).toBe('failed');
      expect(orchestrator.getTask(taskId)?.execution.failureClass).toBe('liveness_stall');
      return { adapter, orchestrator, workflowId, taskId };
    }

    it('repro: the requeue worker tick fails the intent when invoker:requeue-escalate has no dispatcher', async () => {
      const { adapter, orchestrator, workflowId, taskId } = await setUpStalledLivenessTask();
      const logger = makeLogger();
      const dispatcher: Dispatcher = new Map(); // deliberately missing invoker:requeue-escalate
      const { submit } = makeCoordinatorAndSubmit(adapter, dispatcher, logger);

      const tick = createRequeueRecoveryTick({
        store: adapter,
        submitter: { submit },
        logger,
        ledger: createRequeueAttemptLedger(),
        stallRequeueRetries: 0, // forces escalate on the very first decision instead of a plain requeue
      });

      await expect(tick({ reason: 'poll' } as never)).resolves.toBeUndefined();
      await waitFor(() => adapter.listWorkflowMutationIntents(workflowId, ['failed']).length === 1);

      const failed = adapter.listWorkflowMutationIntents(workflowId, ['failed']);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ channel: REQUEUE_ESCALATE_CHANNEL });
      expect(failed[0]?.error ?? '').toContain(`No workflow mutation dispatcher registered for ${REQUEUE_ESCALATE_CHANNEL}`);
      // The task is left stuck failed forever — no needs_input escalation ever reaches the user.
      expect(orchestrator.getTask(taskId)?.status).toBe('failed');
    });

    it('fix: with the real handler registered, the same tick escalates the task to needs_input', async () => {
      const { adapter, orchestrator, workflowId, taskId } = await setUpStalledLivenessTask();
      const logger = makeLogger();
      const commandService = new CommandService(orchestrator);
      const dispatcher: Dispatcher = new Map();
      dispatcher.set(REQUEUE_ESCALATE_CHANNEL, async (...args: unknown[]) => {
        await executeRequeueEscalateMutation(args, { commandService, logger });
        return { ok: true };
      });
      const { submit } = makeCoordinatorAndSubmit(adapter, dispatcher, logger);

      const tick = createRequeueRecoveryTick({
        store: adapter,
        submitter: { submit },
        logger,
        ledger: createRequeueAttemptLedger(),
        stallRequeueRetries: 0,
      });

      await expect(tick({ reason: 'poll' } as never)).resolves.toBeUndefined();
      await waitFor(() => adapter.listWorkflowMutationIntents(workflowId, ['completed']).length === 1);

      const intents = adapter.listWorkflowMutationIntents(workflowId);
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ channel: REQUEUE_ESCALATE_CHANNEL, status: 'completed' });
      expect(adapter.listWorkflowMutationIntents(workflowId, ['failed'])).toEqual([]);
      expect(orchestrator.getTask(taskId)?.status).toBe('needs_input');
    });
  });
});
