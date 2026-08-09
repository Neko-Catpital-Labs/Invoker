import {
  AUTO_APPROVE_COMMAND_CHANNEL,
  AUTO_FIX_BARE_RETRY_CHANNEL,
  AUTO_FIX_COMMAND_CHANNEL,
  buildHeadlessFixArgs,
  INFRA_REPAIR_RECREATE_TASK_CHANNEL,
  INFRA_REPAIR_RETRY_TASK_CHANNEL,
  parseFixWithAgentMutationArgs,
  parseInfraRepairRecreateTaskMutationArgs,
  parseInfraRepairRetryTaskMutationArgs,
  parseRequeueMutationArgs,
  REQUEUE_COMMAND_CHANNEL,
  REQUEUE_ESCALATE_CHANNEL,
  WORKER_SUBMITTED_MUTATION_CHANNELS,
  type TaskRunner,
} from '@invoker/execution-engine';

import type { Logger } from '@invoker/contracts';
import type { CommandService, Orchestrator } from '@invoker/workflow-core';

import { executeApproveTaskMutation } from './standalone-approve-task-dispatcher.js';
import { executeRequeueEscalateMutation } from './standalone-requeue-escalate-dispatcher.js';
import type { WorkflowMutationTiming } from './workflow-mutation-timing.js';

export type WorkflowMutationHandler = (...args: unknown[]) => Promise<unknown>;

export interface WorkerMutationHandlerDeps {
  orchestrator: Orchestrator;
  commandService: CommandService;
  logger: Logger;
  /**
   * Runs a headless-command-shaped mutation (`['retry-task', taskId]` etc.),
   * the same operation every pre-existing `runHeadless(...)`-based handler
   * performs. Standalone mode passes `runHeadless` directly; owner mode has
   * no `HeadlessDeps` of its own and instead delegates through
   * `mutationActions.executeHeadlessExec` — this abstraction lets both modes
   * share one handler implementation without needing the same concrete
   * execution mechanism.
   */
  runHeadlessCommand: (args: string[]) => Promise<unknown>;
  /**
   * Resolved fresh on every dispatch (matches how the pre-existing
   * standalone/owner blocks already call `createStandaloneTaskExecutor()` /
   * `requireTaskExecutor()` inline rather than capturing a stale instance).
   */
  getTaskExecutor: () => TaskRunner;
  /** Read fresh per dispatch — both modes track this as a mutable local variable. */
  getMutationTiming: () => WorkflowMutationTiming | undefined;
  /** `'standalone'` or `'owner'` — only used for log/context strings. */
  contextLabel: string;
}

/**
 * Builds every worker-submitted mutation channel's handler exactly once.
 * Call this identically from both `main.ts`'s standalone-mode block and its
 * owner-mode IPC delegation block so the two can never drift out of sync
 * again — that drift is the root cause behind the `invoker:retry-task` gap
 * recurring three times (#6808, #7643, #8060) and the `invoker:approve` /
 * `invoker:requeue-escalate` gaps found in this repo's mutation-channel audit.
 *
 * `invoker:start-ready` is intentionally NOT included here even though it is
 * a worker-submitted channel: both blocks already register a working (if
 * structurally different) handler for it today, so unifying it here would be
 * pure risk with no bug to fix. It stays in `WORKER_SUBMITTED_MUTATION_CHANNELS`
 * so completeness checks still cover it.
 */
export function buildWorkerMutationHandlers(deps: WorkerMutationHandlerDeps): Map<string, WorkflowMutationHandler> {
  const { orchestrator, commandService, logger, runHeadlessCommand, getTaskExecutor, getMutationTiming, contextLabel } = deps;
  const handlers = new Map<string, WorkflowMutationHandler>();

  handlers.set(AUTO_FIX_COMMAND_CHANNEL, async (...fixArgs: unknown[]) => {
    const { taskId, agentName, context } = parseFixWithAgentMutationArgs(fixArgs);
    return runHeadlessCommand(buildHeadlessFixArgs(taskId, agentName, context));
  });

  handlers.set(AUTO_FIX_BARE_RETRY_CHANNEL, async (...retryArgs: unknown[]) => {
    return runHeadlessCommand(['retry-task', String(retryArgs[0])]);
  });

  handlers.set(REQUEUE_COMMAND_CHANNEL, async (...requeueArgs: unknown[]) => {
    const { taskId } = parseRequeueMutationArgs(requeueArgs);
    return runHeadlessCommand(['retry-task', taskId]);
  });

  handlers.set(INFRA_REPAIR_RETRY_TASK_CHANNEL, async (...retryArgs: unknown[]) => {
    const { taskId } = parseInfraRepairRetryTaskMutationArgs(retryArgs);
    return runHeadlessCommand(['retry-task', taskId]);
  });

  handlers.set(INFRA_REPAIR_RECREATE_TASK_CHANNEL, async (...recreateArgs: unknown[]) => {
    const { taskId } = parseInfraRepairRecreateTaskMutationArgs(recreateArgs);
    return runHeadlessCommand(['recreate-task', taskId]);
  });

  handlers.set(AUTO_APPROVE_COMMAND_CHANNEL, async (...args: unknown[]) => {
    await executeApproveTaskMutation(args[0], {
      commandService,
      orchestrator,
      taskExecutor: getTaskExecutor(),
      logger,
      context: `${contextLabel}.approve`,
      mutationTiming: getMutationTiming(),
    });
    return { ok: true };
  });

  handlers.set(REQUEUE_ESCALATE_CHANNEL, async (...args: unknown[]) => {
    await executeRequeueEscalateMutation(args, { commandService, logger });
    return { ok: true };
  });

  return handlers;
}

/**
 * Throws once, naming every missing channel, if any worker-submitted
 * channel lacks a registered handler. Call this immediately after wiring
 * `buildWorkerMutationHandlers()` into the live dispatcher, before the
 * process finishes starting standalone/owner mode — a missing handler here
 * means a background worker's mutation will silently fail (marked `failed`
 * on the persisted intent, no crash, easy to miss) the first time it is
 * actually dispatched, so failing fast at boot is deliberately louder than
 * that.
 */
export function assertAllWorkerMutationChannelsRegistered(
  dispatcher: Pick<Map<string, unknown>, 'has'>,
  contextLabel: string,
): void {
  const missing = WORKER_SUBMITTED_MUTATION_CHANNELS.filter((channel) => !dispatcher.has(channel));
  if (missing.length > 0) {
    throw new Error(
      `[${contextLabel}] Missing workflowMutationDispatcher registration for worker-submitted channel(s): ` +
      `${missing.join(', ')}. A background worker that submits through any of these channels will have its ` +
      'mutation silently fail the first time it is dispatched. Add the missing handler(s) to ' +
      'buildWorkerMutationHandlers() in workflow-mutation-handlers.ts.',
    );
  }
}
