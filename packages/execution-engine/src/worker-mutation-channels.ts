import { AUTO_FIX_BARE_RETRY_CHANNEL, AUTO_FIX_COMMAND_CHANNEL } from './auto-fix-recovery.js';
import { AUTO_APPROVE_COMMAND_CHANNEL } from './workers/auto-approve-worker.js';
import { INFRA_REPAIR_RECREATE_TASK_CHANNEL, INFRA_REPAIR_RETRY_TASK_CHANNEL } from './workers/infra-repair-worker.js';
import { REQUEUE_COMMAND_CHANNEL, REQUEUE_ESCALATE_CHANNEL } from './workers/requeue-worker.js';
import { WORKFLOW_RESUME_COMMAND_CHANNEL } from './workers/workflow-resume-worker.js';

/**
 * Every channel a built-in background worker uses to submit a mutation
 * intent (via its injected submitter), i.e. every channel that a running
 * owner/standalone process must have a `workflowMutationDispatcher` handler
 * registered for, or a worker's submission silently fails once
 * `PersistedWorkflowMutationCoordinator` tries to dispatch it.
 *
 * This list exists because the same channel gap has landed in production
 * three times for one channel alone (`invoker:retry-task`: #6808 merged as a
 * no-op, #7643 fixed the standalone block, #8060 fixed the owner-mode IPC
 * delegation block) because nothing forced the hand-written registration
 * blocks in `packages/app/src/main.ts` to list the same channels. Add a new
 * worker-submitted channel here the same commit you wire the worker's own
 * submission call, so `assertAllWorkerMutationChannelsRegistered` and the
 * completeness test catch a missing registration immediately instead of
 * shipping a mutation that silently never runs.
 */
export const WORKER_SUBMITTED_MUTATION_CHANNELS: readonly string[] = [
  AUTO_FIX_COMMAND_CHANNEL,
  AUTO_FIX_BARE_RETRY_CHANNEL,
  AUTO_APPROVE_COMMAND_CHANNEL,
  REQUEUE_COMMAND_CHANNEL,
  REQUEUE_ESCALATE_CHANNEL,
  INFRA_REPAIR_RETRY_TASK_CHANNEL,
  INFRA_REPAIR_RECREATE_TASK_CHANNEL,
  WORKFLOW_RESUME_COMMAND_CHANNEL,
];
