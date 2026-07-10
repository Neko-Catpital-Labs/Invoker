/**
 * Extracted lifecycle domain.
 *
 * Retry/recreate lifecycle primitives and their subgraph reset helpers live here
 * behind a LifecycleHost. Orchestrator keeps API-compatible delegates and owns
 * mutable scalar state such as lastInvalidationPlan.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { TaskState, TaskDelta, TaskStateChanges, TaskStatus, Attempt } from '@invoker/workflow-graph';
import { getTransitiveDependents } from '@invoker/workflow-graph';
import type { Logger } from '@invoker/contracts';
import {
  OrchestratorError,
  OrchestratorErrorCode,
} from '../orchestrator.js';
import type {
  OrchestratorPersistence,
  OrchestratorMessageBus,
} from '../orchestrator.js';
import type { TaskStateMachine } from '../state-machine.js';
import type { TaskRepository } from '../task-repository.js';
import {
  planInvalidation,
  withSchedulerEnqueueCandidates,
  type InvalidationPlan,
} from '../invalidation-plan.js';
import type { InvalidationAction } from '../invalidation-policy.js';
import { buildTaskResetChanges, type TaskResetKind } from '../task-reset-policy.js';

const TASK_DELTA_CHANNEL = 'task.delta';
const MERGE_TRACE_LOG = resolve(homedir(), '.invoker', 'merge-trace.log');

export const EXPEDITED_PRIORITY = 100;

/** Recreate-class reset: fresh lineage, cleared attempt/session/container metadata. */
const RECREATE_RESET_CHANGES: TaskStateChanges = buildTaskResetChanges('recreate', {
  config: { summary: undefined },
});

function mergeTrace(tag: string, data: Record<string, unknown>): void {
  try {
    mkdirSync(resolve(homedir(), '.invoker'), { recursive: true });
    appendFileSync(MERGE_TRACE_LOG, `${new Date().toISOString()} [merge-trace:orchestrator] ${tag} ${JSON.stringify(data)}\n`);
  } catch { /* best effort */ }
}

export interface LifecycleHost {
  readonly stateMachine: TaskStateMachine;
  readonly persistence: OrchestratorPersistence;
  readonly messageBus: OrchestratorMessageBus;
  readonly taskRepository: TaskRepository;
  readonly logger: Logger;
  readonly deferredTaskIds: Set<string>;
  lastInvalidationPlan?: InvalidationPlan;

  refreshFromDb(): void;
  refreshWorkflowFromDb(workflowId: string): void;
  stateGetTask(taskId: string): TaskState | undefined;
  writeAndSync(
    taskId: string,
    changes: TaskStateChanges,
    opts?: { skipWorkflowStatusSync?: boolean },
  ): TaskState;
  writeResetAndSync(
    before: TaskState,
    kind: TaskResetKind,
    changes: TaskStateChanges,
    opts?: { skipWorkflowStatusSync?: boolean },
  ): TaskState;
  buildUpdateDelta(before: TaskState, after: TaskState, changes: TaskStateChanges): TaskDelta;
  replaceSelectedAttempt(
    task: TaskState,
    opts?: Partial<Omit<Attempt, 'id' | 'nodeId' | 'createdAt'>>,
    writeOpts?: { skipWorkflowStatusSync?: boolean },
  ): string;
  clearQueuedSchedulerEntries(taskId: string, attemptId?: string): void;
  getSelectedAttempt(task: TaskState | undefined): Attempt | undefined;
  isAttemptLeaseActive(attempt: Attempt | undefined, now?: number): boolean;
  withBumpedExecutionGenerationAndDiscardedReviewGate(
    task: TaskState,
    changes: TaskStateChanges,
    discardReason: string,
  ): TaskStateChanges;
  touchWorkflow(workflowId: string): void;
  collectSubgraphTaskIds(rootTaskIds: string[]): string[];
  invalidateLaunchArtifactsForTasks(taskIds: readonly string[], reason: string, now?: Date): void;
  resetSubgraphToPending(
    rootTaskIds: string[],
    kind: TaskResetKind,
    resetChanges: TaskStateChanges,
    opts?: { forceResetIds?: Set<string> },
  ): { affectedIds: string[]; readyIds: string[] };
  cancelActiveBeforeInvalidation(scope: 'task' | 'workflow', id: string): string[];
  cancelActiveCandidates(candidates: readonly TaskState[], scope: 'task' | 'workflow'): string[];
  autoStartReadyTasks(taskIds: string[], priority?: number): TaskState[];
  getExternalDependencyBlocker(task: TaskState): string | undefined;
  applyRecreateReset(plan: InvalidationPlan, artifactReason: string): TaskState[];
  bumpWorkflowGeneration(workflowId: string): void;
  retryTask(taskId: string): TaskState[];
  recreateTask(taskId: string): TaskState[];
}

export function collectSubgraphTaskIdsImpl(host: LifecycleHost, rootTaskIds: string[]): string[] {
  const allTasks = host.stateMachine.getAllTasks();
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const rootId of rootTaskIds) {
    if (!taskMap.has(rootId)) continue;
    if (!seen.has(rootId)) {
      seen.add(rootId);
      ids.push(rootId);
    }
    const descendantIds = getTransitiveDependents(rootId, taskMap, () => false);
    for (const id of descendantIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

export function invalidateLaunchArtifactsForTasksImpl(
  host: LifecycleHost,
  taskIds: readonly string[],
  reason: string,
  now: Date = new Date(),
): void {
  const ids = Array.from(new Set(taskIds.filter((id) => typeof id === 'string' && id.length > 0)));
  if (ids.length === 0) return;

  const invalidatedAt = now.toISOString();
  const invalidatedDispatches =
    host.persistence.abandonLaunchDispatchesForTasks?.(ids, reason, invalidatedAt) ?? [];
  const releasedLeases =
    host.persistence.releaseExecutionResourceLeasesForTasks?.(ids, reason, invalidatedAt) ?? [];

  for (const row of invalidatedDispatches) {
    host.persistence.logEvent?.(row.taskId, 'task.launch_dispatch_invalidated', {
      dispatchId: row.id,
      attemptId: row.attemptId,
      workflowId: row.workflowId,
      previousState: row.state,
      generation: row.generation,
      reason,
      invalidatedAt,
    });
  }

  for (const row of releasedLeases) {
    if (!row.taskId) continue;
    host.persistence.logEvent?.(row.taskId, 'task.execution_resource_lease_released', {
      resourceKey: row.resourceKey,
      resourceType: row.resourceType,
      holderId: row.holderId,
      reason,
      invalidatedAt,
    });
  }
}

export function resetSubgraphToPendingImpl(
  host: LifecycleHost,
  rootTaskIds: string[],
  kind: TaskResetKind,
  resetChanges: TaskStateChanges,
  opts?: { forceResetIds?: Set<string> },
): { affectedIds: string[]; readyIds: string[] } {
  const forceResetIds = opts?.forceResetIds ?? new Set<string>();
  const affectedIds = host.collectSubgraphTaskIds(rootTaskIds);
  const affectedSet = new Set(affectedIds);
  const workflowsToSync = new Set<string>();
  const pendingTaskDeltas: TaskDelta[] = [];

  host.taskRepository.runInTransaction(() => {
    host.invalidateLaunchArtifactsForTasks(affectedIds, 'task subgraph reset to pending');

    for (const id of affectedIds) {
      const current = host.stateGetTask(id);
      if (!current) continue;
      if (current.config.workflowId) {
        workflowsToSync.add(current.config.workflowId);
      }

      const selectedAttempt = host.getSelectedAttempt(current);
      const shouldReset =
        forceResetIds.has(id)
        || current.status !== 'pending'
        || host.isAttemptLeaseActive(selectedAttempt);
      host.deferredTaskIds.delete(id);
      if (!shouldReset) {
        host.clearQueuedSchedulerEntries(id, current.execution.selectedAttemptId);
        continue;
      }

      const changesWithGeneration = host.withBumpedExecutionGenerationAndDiscardedReviewGate(
        current,
        resetChanges,
        'task subgraph reset to pending',
      );
      const updated = host.writeResetAndSync(current, kind, changesWithGeneration, { skipWorkflowStatusSync: true });
      const priorAttemptId = current.execution.selectedAttemptId;
      host.replaceSelectedAttempt(current, {}, { skipWorkflowStatusSync: true });
      host.persistence.logEvent?.(id, 'task.pending', changesWithGeneration);
      pendingTaskDeltas.push(host.buildUpdateDelta(current, updated, changesWithGeneration));

      host.clearQueuedSchedulerEntries(id, priorAttemptId);
    }

    for (const workflowId of workflowsToSync) {
      host.touchWorkflow(workflowId);
    }
  });

  for (const delta of pendingTaskDeltas) {
    host.messageBus.publish(TASK_DELTA_CHANNEL, delta);
  }

  const readyIds = host.stateMachine
    .getReadyTasks()
    .map((t) => t.id)
    .filter((id) => affectedSet.has(id));
  return { affectedIds, readyIds };
}

export function restartTaskImpl(host: LifecycleHost, taskId: string): TaskState[] {
  host.logger.warn(
    '[orchestrator] restartTask is deprecated. Routing to recreateTask. Use retryTask() for lineage-preserving reset or recreateTask() for fresh-lineage reset explicitly.',
    { taskId },
  );
  return host.recreateTask(taskId);
}

export function retryTaskImpl(host: LifecycleHost, taskId: string): TaskState[] {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);
  const id = task.id;

  // Step 18 (`docs/architecture/task-invalidation-roadmap.md`,
  // Hard Invariant): cancel any active attempt on this task or its
  // downstream subgraph BEFORE the reset writes pending state.
  // Defense-in-depth for direct callers (CommandService.retryTask
  // wired in Step 17) that bypass `applyInvalidation`'s upstream
  // cancel; a no-op when invoked through `applyInvalidation`.
  host.cancelActiveBeforeInvalidation('task', id);
  let plan = planInvalidation({
    action: 'retryTask',
    targetId: id,
    tasks: host.stateMachine.getAllTasks(),
  });
  host.lastInvalidationPlan = plan;

  const prevStatus = task.status;
  host.logger.info('[orchestrator] retryTask', { taskId: id, previousStatus: prevStatus });
  if (task.config.isMergeNode) {
    host.logger.info('[merge-gate-workspace] retryTask before reset', {
      mergeNode: id,
      workspacePath: task.execution.workspacePath ?? 'none',
      note: 'retryTask does not clear workspacePath',
    });
    mergeTrace('GATE_WS_RETRY_TASK_MERGE', {
      taskId: id,
      workspacePathBefore: task.execution.workspacePath ?? null,
    });
  }

  const resetChanges: TaskStateChanges = buildTaskResetChanges('retryTask', {
    config: { summary: undefined },
  });
  const t0 = host.stateGetTask(id)!;
  host.logger.info('[agent-session-trace] retryTask: before writeAndSync', {
    taskId: id,
    agentSessionId: t0.execution.agentSessionId ?? 'null',
    note: 'reset clears agentSessionId/containerId; branch/workspacePath unchanged',
  });
  const { affectedIds } = host.resetSubgraphToPending([id], 'retryTask', resetChanges, {
    forceResetIds: new Set([id]),
  });
  host.lastInvalidationPlan = plan;
  const afterRt = host.stateGetTask(id)!;
  host.logger.info('[agent-session-trace] retryTask: after writeAndSync', {
    taskId: id,
    agentSessionId: afterRt.execution.agentSessionId ?? 'null',
  });
  if (afterRt.config.isMergeNode) {
    host.logger.info('[merge-gate-workspace] retryTask after reset', {
      mergeNode: id,
      workspacePath: afterRt.execution.workspacePath ?? 'none',
    });
    mergeTrace('GATE_WS_RETRY_TASK_MERGE_AFTER', {
      taskId: id,
      workspacePathAfter: afterRt.execution.workspacePath ?? null,
    });
  }
  if (affectedIds.length > 1) {
    host.logger.info('[orchestrator] retryTask invalidated downstream tasks', {
      taskId: id,
      invalidatedCount: affectedIds.length - 1,
    });
  }

  const readyTasks = host.stateMachine.getReadyTasks();
  const isReady = readyTasks.some((t) => t.id === id);
  host.logger.info('[orchestrator] retryTask ready check', { taskId: id, ready: isReady });
  if (isReady) {
    const started = host.autoStartReadyTasks([id], EXPEDITED_PRIORITY);
    if (started.some((t) => t.id === id)) return started;

    const current = host.stateGetTask(id);
    if (current) {
      const blocker = host.getExternalDependencyBlocker(current);
      if (blocker !== undefined) {
        const blockedChanges: TaskStateChanges = {
          status: 'blocked',
          execution: { blockedBy: blocker },
        };
        const blockedUpdated = host.writeAndSync(id, blockedChanges);
        const blockedDelta: TaskDelta = host.buildUpdateDelta(current, blockedUpdated, blockedChanges);
        host.persistence.logEvent?.(id, 'task.blocked', blockedChanges);
        host.messageBus.publish(TASK_DELTA_CHANNEL, blockedDelta);
        return [host.stateGetTask(id)!];
      }
    }
  }

  return [host.stateGetTask(id)!];
}

export function retryWorkflowImpl(host: LifecycleHost, workflowId: string): TaskState[] {
  const retryStartMs = Date.now();
  host.refreshWorkflowFromDb(workflowId);
  const afterRefreshMs = Date.now();

  let allTasks = host.stateMachine.getAllTasks().filter(
    (t) => t.config.workflowId === workflowId,
  );
  if (allTasks.length === 0) throw new Error(`No tasks found for workflow ${workflowId}`);

  // Step 18 cancel-first invariant: interrupt any active task in
  // the workflow scope BEFORE the retry reset. Defense-in-depth
  // for direct callers (CommandService.retryWorkflow wired in
  // Step 17); a no-op when invoked through `applyInvalidation`.
  // Re-snapshot tasks afterwards so the retry filter (which
  // includes 'failed' in `retryStatuses`) re-picks any newly
  // cancelled tasks for reset to pending.
  host.cancelActiveBeforeInvalidation('workflow', workflowId);
  allTasks = host.stateMachine.getAllTasks().filter(
    (t) => t.config.workflowId === workflowId,
  );

  const retryStatuses: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
    'failed',
    'needs_input',
    'blocked',
    'stale',
    'fixing_with_ai',
    'awaiting_approval',
    'review_ready',
  ]);
  let plan = planInvalidation({
    action: 'retryWorkflow',
    targetId: workflowId,
    tasks: host.stateMachine.getAllTasks(),
    retryStatuses,
  });
  host.lastInvalidationPlan = plan;

  const resetChanges: TaskStateChanges = buildTaskResetChanges('retryWorkflow', {
    config: { summary: undefined },
  });

  const retryRootIds = allTasks
    .filter((task) => retryStatuses.has(task.status))
    .map((task) => task.id);
  const { affectedIds } = host.resetSubgraphToPending(retryRootIds, 'retryWorkflow', resetChanges);
  plan = withSchedulerEnqueueCandidates(plan, affectedIds);
  host.lastInvalidationPlan = plan;
  const afterResetMs = Date.now();

  host.logger.info('[orchestrator] retryWorkflow invalidation', {
    workflowId,
    roots: retryRootIds,
    affected: affectedIds.length,
  });
  host.logger.info('[orchestrator] retryWorkflow reset summary', {
    workflowId,
    resetCount: affectedIds.length,
    totalTasks: allTasks.length,
    rootCount: retryRootIds.length,
    note: 'preserved completed outside invalidated subgraphs',
  });

  const readyIds = host.stateMachine
    .getReadyTasks()
    .map((t) => t.id)
    .filter((id) => {
      const task = host.stateGetTask(id);
      return !!task
        && task.config.workflowId === workflowId;
    });
  const started = host.autoStartReadyTasks(readyIds, EXPEDITED_PRIORITY);
  const retryEndMs = Date.now();
  host.logger.info('[orchestrator] retryWorkflow timing', {
    workflowId,
    refreshMs: afterRefreshMs - retryStartMs,
    resetMs: afterResetMs - afterRefreshMs,
    enqueueDrainMs: retryEndMs - afterResetMs,
    totalMs: retryEndMs - retryStartMs,
    started: started.length,
  });
  return started;
}

export function recreateTaskImpl(host: LifecycleHost, taskId: string): TaskState[] {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);

  const rootId = task.id;

  // Step 18 cancel-first invariant: interrupt active attempts on
  // this task / downstream subgraph BEFORE the recreate reset.
  // Defense-in-depth for direct callers (CommandService.recreateTask
  // wired in Step 17); a no-op when invoked through `applyInvalidation`.
  host.cancelActiveBeforeInvalidation('task', rootId);
  const plan = planInvalidation({
    action: 'recreateTask',
    targetId: rootId,
    tasks: host.stateMachine.getAllTasks(),
  });
  host.lastInvalidationPlan = plan;
  host.logger.info('[orchestrator] recreateTask reset', {
    taskId: rootId,
    resetCount: plan.affectedTaskIds.length,
  });
  return host.applyRecreateReset(plan, 'task recreation reset');
}

export function applyRecreateResetImpl(host: LifecycleHost, plan: InvalidationPlan, artifactReason: string): TaskState[] {
  const toResetIds = plan.affectedTaskIds;
  const toResetSet = new Set(toResetIds);
  host.invalidateLaunchArtifactsForTasks(toResetIds, artifactReason);

  for (const id of toResetIds) {
    const current = host.stateGetTask(id);
    if (!current) continue;
    const changesWithGeneration = host.withBumpedExecutionGenerationAndDiscardedReviewGate(
      current,
      RECREATE_RESET_CHANGES,
      artifactReason,
    );
    const recreateUpdated = host.writeResetAndSync(current, 'recreate', changesWithGeneration);
    const priorAttemptId = current.execution.selectedAttemptId;
    host.replaceSelectedAttempt(current);
    host.persistence.logEvent?.(id, 'task.pending', changesWithGeneration);
    host.messageBus.publish(TASK_DELTA_CHANNEL, host.buildUpdateDelta(current, recreateUpdated, changesWithGeneration));

    host.deferredTaskIds.delete(id);
    host.clearQueuedSchedulerEntries(id, priorAttemptId);
  }

  const readyIds = host.stateMachine
    .getReadyTasks()
    .map((t) => t.id)
    .filter((id) => toResetSet.has(id));
  host.lastInvalidationPlan = withSchedulerEnqueueCandidates(plan, readyIds);
  return host.autoStartReadyTasks(readyIds, EXPEDITED_PRIORITY);
}

export function recreateDownstreamImpl(host: LifecycleHost, taskId: string): TaskState[] {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) throw new OrchestratorError(OrchestratorErrorCode.TASK_NOT_FOUND, `Task ${taskId} not found`);

  const rootId = task.id;

  const plan = planInvalidation({
    action: 'recreateDownstream',
    targetId: rootId,
    tasks: host.stateMachine.getAllTasks(),
  });
  host.lastInvalidationPlan = plan;
  const toResetIds = plan.affectedTaskIds;

  if (toResetIds.length === 0) {
    host.logger.info('[orchestrator] recreateDownstream no-op (leaf)', { taskId: rootId });
    return [];
  }

  // Cancel only descendants so the preserved target's active attempt is never interrupted.
  const descendants = toResetIds
    .map((id) => host.stateGetTask(id))
    .filter((t): t is TaskState => !!t);
  host.cancelActiveCandidates(descendants, 'task');

  host.logger.info('[orchestrator] recreateDownstream reset', {
    taskId: rootId,
    resetCount: toResetIds.length,
  });
  return host.applyRecreateReset(plan, 'downstream recreation reset');
}

export function bumpWorkflowGenerationImpl(host: LifecycleHost, workflowId: string): void {
  if (!host.persistence.updateWorkflow) return;
  if (!host.persistence.loadWorkflow) {
    return;
  }
  const workflow = host.persistence.loadWorkflow(workflowId);
  const nextGeneration = (workflow?.generation ?? 0) + 1;
  host.persistence.updateWorkflow(workflowId, { generation: nextGeneration });
  host.logger.info('[orchestrator] bumped workflow generation for recreate', {
    workflowId,
    generation: nextGeneration,
  });
}

export function recreateWorkflowImpl(host: LifecycleHost, workflowId: string): TaskState[] {
  host.refreshFromDb();

  const allTasks = host.stateMachine.getAllTasks().filter(
    (t) => t.config.workflowId === workflowId,
  );
  if (allTasks.length === 0) throw new Error(`No tasks found for workflow ${workflowId}`);

  // Step 18 cancel-first invariant: interrupt any active task in
  // the workflow scope BEFORE the recreate reset. Defense-in-depth
  // for direct callers (CommandService.recreateWorkflow and
  // recreateWorkflowFromFreshBase wired in Step 17); a no-op when
  // invoked through `applyInvalidation`.
  host.cancelActiveBeforeInvalidation('workflow', workflowId);
  let plan = planInvalidation({
    action: 'recreateWorkflow',
    targetId: workflowId,
    tasks: host.stateMachine.getAllTasks(),
  });
  host.lastInvalidationPlan = plan;

  host.bumpWorkflowGeneration(workflowId);

  const resetChanges: TaskStateChanges = buildTaskResetChanges('recreate', {
    config: { summary: undefined, poolMemberId: undefined },
  });

  host.logger.info('[orchestrator] recreateWorkflow reset', {
    workflowId,
    resetCount: allTasks.length,
  });
  host.logger.info(
    '[agent-session-trace] recreateWorkflow: resetChanges.execution clears agentSessionId/containerId (DB NULL before next run)',
  );
  host.invalidateLaunchArtifactsForTasks(
    allTasks.map((task) => task.id),
    'workflow recreation reset',
  );
  for (const task of allTasks) {
    const prevSess = task.execution.agentSessionId ?? null;
    const prevCt = task.execution.containerId ?? null;
    if (task.config.isMergeNode) {
      host.logger.info('[merge-gate-workspace] recreateWorkflow', {
        mergeNode: task.id,
        workspacePath: task.execution.workspacePath ?? 'NULL',
        note: 'will clear workspace_path',
      });
      mergeTrace('GATE_WS_RESTART_WORKFLOW_MERGE', {
        taskId: task.id,
        workspacePathBefore: task.execution.workspacePath ?? null,
      });
    }
    host.logger.info('[orchestrator] recreateWorkflow task reset', {
      taskId: task.id,
      previousStatus: task.status,
      branch: task.execution.branch ?? 'none',
      commit: task.execution.commit?.slice(0, 7) ?? 'none',
    });
    host.logger.info('[agent-session-trace] recreateWorkflow: before writeAndSync', {
      taskId: task.id,
      agentSessionId: prevSess ?? 'null',
      containerId: prevCt ?? 'null',
    });
    const changesWithGeneration = host.withBumpedExecutionGenerationAndDiscardedReviewGate(
      task,
      resetChanges,
      'workflow recreation reset',
    );
    const after = host.writeResetAndSync(task, 'recreate', changesWithGeneration);
    const priorAttemptId = task.execution.selectedAttemptId;
    host.replaceSelectedAttempt(task);
    host.logger.info('[agent-session-trace] recreateWorkflow: after writeAndSync', {
      taskId: task.id,
      agentSessionId: after.execution.agentSessionId ?? 'null',
      containerId: after.execution.containerId ?? 'null',
    });
    const delta: TaskDelta = host.buildUpdateDelta(task, after, changesWithGeneration);
    host.persistence.logEvent?.(task.id, 'task.pending', changesWithGeneration);
    host.messageBus.publish(TASK_DELTA_CHANNEL, delta);
    host.clearQueuedSchedulerEntries(task.id, priorAttemptId);
  }

  const readyIds = host.stateMachine
    .getReadyTasks()
    .map((t) => t.id)
    .filter((id) => host.stateGetTask(id)?.config.workflowId === workflowId);
  plan = withSchedulerEnqueueCandidates(plan, readyIds);
  host.lastInvalidationPlan = plan;
  return host.autoStartReadyTasks(readyIds, EXPEDITED_PRIORITY);
}

export function dispatchPostMutationImpl(
  host: LifecycleHost,
  action: InvalidationAction,
  taskId: string,
): TaskState[] {
  switch (action) {
    case 'recreateTask':
      return host.recreateTask(taskId);
    case 'retryTask':
      return host.retryTask(taskId);
    default:
      throw new Error(
        `dispatchPostMutation: unsupported action '${action}' for orchestrator edit primitives`,
      );
  }
}
