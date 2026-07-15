/**
 * Extracted scheduler domain.
 *
 * These functions implement ready-task scheduling and launch dispatch as
 * standalone functions that operate on a `SchedulerDomainHost`. The
 * Orchestrator delegates to them, keeping the methods on the class for API
 * compatibility (see `graph-mutation.ts` for the same host-delegation
 * pattern).
 *
 * Behavior is intentionally identical to the previous in-class methods:
 * dependency-readiness checks, priority enqueue, and the `task_launch_dispatch`
 * outbox handoff in `drainScheduler` are preserved exactly.
 */

import type { TaskState, TaskDelta, TaskStateChanges, Attempt } from '@invoker/workflow-graph';
import { topologicalSort } from '@invoker/workflow-graph';
import { ATTEMPT_LEASE_MS } from '@invoker/contracts';
import type { Logger } from '@invoker/contracts';
import { isDiscardedAttempt } from '../attempt-policy.js';
import { assertResetComplete, buildTaskResetChanges } from '../task-reset-policy.js';
import type { TaskStateMachine } from '../state-machine.js';
import type { TaskJob, TaskScheduler } from '../scheduler.js';
import type { TaskRepository } from '../task-repository.js';
import type {
  OrchestratorPersistence,
  OrchestratorMessageBus,
  TaskLaunchReadiness,
  LaunchReadinessOptions,
} from '../orchestrator.js';

const TASK_DELTA_CHANNEL = 'task.delta';

function nextLeaseExpiry(from: Date): Date {
  return new Date(from.getTime() + ATTEMPT_LEASE_MS);
}

// ── Host Interface ──────────────────────────────────────────

/**
 * Subset of Orchestrator that the scheduler-domain functions need.
 * Keeps the extracted functions decoupled from the full Orchestrator class.
 */
export interface SchedulerDomainHost {
  readonly stateMachine: TaskStateMachine;
  readonly scheduler: TaskScheduler;
  readonly persistence: OrchestratorPersistence;
  readonly messageBus: OrchestratorMessageBus;
  readonly logger: Logger;
  readonly taskRepository: TaskRepository;
  readonly maxConcurrency: number;
  readonly deferRunningUntilLaunch: boolean;

  refreshFromDb(): void;
  stateGetTask(taskId: string): TaskState | undefined;
  writeAndSync(
    taskId: string,
    changes: TaskStateChanges,
    opts?: { skipWorkflowStatusSync?: boolean },
  ): TaskState;
  buildUpdateDelta(before: TaskState, after: TaskState, changes: TaskStateChanges): TaskDelta;
  replaceSelectedAttempt(
    task: TaskState,
    opts?: Partial<Omit<Attempt, 'id' | 'nodeId' | 'createdAt'>>,
    writeOpts?: { skipWorkflowStatusSync?: boolean },
  ): string;
  ensureCurrentPendingAttempt(task: TaskState): string;
  loadAttemptById(attemptId: string | undefined): Attempt | undefined;
  isAttemptLeaseActive(attempt: Attempt | undefined, now?: number): boolean;
  countActivePersistedAttempts(now?: number): number;
  getExecutionGeneration(task: TaskState | undefined): number;
  getExternalDependencyBlocker(task: TaskState): string | undefined;
}
function byCreatedAtThenId(left: TaskState, right: TaskState): number {
  return (left.createdAt.getTime() - right.createdAt.getTime()) || left.id.localeCompare(right.id);
}

function getCandidatePriority(host: SchedulerDomainHost, task: TaskState, fallback: number): number {
  const attempt = task.execution.selectedAttemptId
    ? host.loadAttemptById(task.execution.selectedAttemptId)
    : undefined;
  return Math.max(fallback, attempt?.queuePriority ?? fallback);
}

function hasActiveLaunchAttempt(
  host: SchedulerDomainHost,
  task: TaskState,
  attemptId: string | undefined,
): boolean {
  if (!attemptId) return false;
  if (task.execution.selectedAttemptId !== attemptId) return false;
  const attempt = host.loadAttemptById(attemptId);
  if (!host.isAttemptLeaseActive(attempt)) return false;
  return task.status === 'running'
    || task.status === 'fixing_with_ai'
    || attempt?.status === 'claimed'
    || attempt?.status === 'running';
}

function planPendingLaunchQueue(host: SchedulerDomainHost, candidateJobs: TaskJob[]): TaskJob[] {
  const mergedJobs = new Map<string, TaskJob>();
  for (const sourceJob of [...host.scheduler.getQueuedJobs(), ...candidateJobs]) {
    const task = host.stateGetTask(sourceJob.taskId);
    if (!task || task.status !== 'pending') continue;
    if (host.getExternalDependencyBlocker(task) !== undefined) continue;
    const knownAttemptId = sourceJob.attemptId ?? task.execution.selectedAttemptId;
    if (hasActiveLaunchAttempt(host, task, knownAttemptId)) continue;
    const existing = mergedJobs.get(task.id);
    mergedJobs.set(task.id, {
      taskId: task.id,
      attemptId: existing?.attemptId ?? knownAttemptId,
      priority: Math.max(existing?.priority ?? sourceJob.priority, sourceJob.priority),
      ...(existing?.bypassLocalDependencyReadiness || sourceJob.bypassLocalDependencyReadiness
        ? { bypassLocalDependencyReadiness: true }
        : {}),
    });
  }

  let topologyIndex: Map<string, number> | undefined;
  try {
    topologyIndex = new Map(
      topologicalSort([...host.stateMachine.getAllTasks()].sort(byCreatedAtThenId))
        .map((task, index) => [task.id, index]),
    );
  } catch (error) {
    host.logger.warn('[orchestrator] rebuildPendingLaunchQueue: topological sort failed; falling back to deterministic order', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const orderedJobs = [...mergedJobs.values()]
    .map((job) => {
      const task = host.stateGetTask(job.taskId);
      if (!task) return undefined;
      return {
        job,
        task,
        ready: getTaskLaunchReadinessImpl(host, job.taskId, {
          bypassLocalDependencyReadiness: job.bypassLocalDependencyReadiness,
        }).ready,
      };
    })
    .filter((entry): entry is { job: TaskJob; task: TaskState; ready: boolean } => entry !== undefined);

  orderedJobs.sort((left, right) => {
    const priorityDiff = right.job.priority - left.job.priority;
    if (priorityDiff !== 0) return priorityDiff;
    const readinessDiff = Number(right.ready) - Number(left.ready);
    if (readinessDiff !== 0) return readinessDiff;
    if (topologyIndex) {
      const topologyDiff = (topologyIndex.get(left.task.id) ?? Number.MAX_SAFE_INTEGER)
        - (topologyIndex.get(right.task.id) ?? Number.MAX_SAFE_INTEGER);
      if (topologyDiff !== 0) return topologyDiff;
    }
    return byCreatedAtThenId(left.task, right.task);
  });

  return orderedJobs.map(({ job }) => job);
}

export function getPendingLaunchQueueSnapshotImpl(
  host: SchedulerDomainHost,
  candidateJobs: TaskJob[],
): TaskJob[] {
  return planPendingLaunchQueue(host, candidateJobs);
}

function rebuildPendingLaunchQueue(host: SchedulerDomainHost, candidateJobs: TaskJob[]): void {
  const orderedJobs = planPendingLaunchQueue(host, candidateJobs)
    .map((job) => {
      const task = host.stateGetTask(job.taskId);
      if (!task) return undefined;
      const attemptId = host.ensureCurrentPendingAttempt(task);
      const currentAttempt = host.loadAttemptById(attemptId);
      if ((currentAttempt?.queuePriority ?? 0) !== job.priority) {
        host.taskRepository.updateAttempt(attemptId, { queuePriority: job.priority });
      }
      return {
        taskId: task.id,
        attemptId,
        priority: job.priority,
        ...(job.bypassLocalDependencyReadiness ? { bypassLocalDependencyReadiness: true } : {}),
      };
    })
    .filter((job): job is TaskJob => job !== undefined);
  host.scheduler.replaceQueue(orderedJobs);
}


// ── Extracted Functions ─────────────────────────────────────

export function autoStartReadyTasksImpl(
  host: SchedulerDomainHost,
  taskIds: string[],
  priority: number = 0,
  opts?: LaunchReadinessOptions,
): TaskState[] {
  const candidateJobs: TaskJob[] = [];
  for (const taskId of taskIds) {
    let task = host.stateGetTask(taskId);
    if (!task) continue;
    if (host.getExternalDependencyBlocker(task) !== undefined) continue;

    // Unblock: if a blocked task's deps are all complete, it's genuinely ready
    if (task.status === 'blocked') {
      host.logger.info('[orchestrator] autoStartReadyTasks: unblocking blocked task', {
        taskId,
      });
      host.replaceSelectedAttempt(task, { status: 'pending' });
      const resetBefore = host.stateGetTask(taskId);
      if (!resetBefore) continue;
      const changes = buildTaskResetChanges('readyUnblock');
      const updated = host.writeAndSync(taskId, changes);
      assertResetComplete(resetBefore, updated, 'readyUnblock', { execution: changes.execution });
      task = host.stateGetTask(taskId);
      if (!task) continue;
    }

    candidateJobs.push({
      taskId,
      attemptId: task.execution.selectedAttemptId,
      priority: getCandidatePriority(host, task, priority),
      ...(opts?.bypassLocalDependencyReadiness ? { bypassLocalDependencyReadiness: true } : {}),
    });
  }

  rebuildPendingLaunchQueue(host, candidateJobs);
  return drainSchedulerImpl(host);
}

export function enqueueIfNotScheduledImpl(
  host: SchedulerDomainHost,
  taskId: string,
  priority: number = 0,
  opts?: LaunchReadinessOptions,
): void {
  const task = host.stateGetTask(taskId);
  if (!task) return;
  if (host.getExternalDependencyBlocker(task) !== undefined) return;
  if (hasActiveLaunchAttempt(host, task, task.execution.selectedAttemptId)) {
    return;
  }

  rebuildPendingLaunchQueue(host, [{
    taskId,
    attemptId: task.execution.selectedAttemptId,
    priority: getCandidatePriority(host, task, priority),
    ...(opts?.bypassLocalDependencyReadiness ? { bypassLocalDependencyReadiness: true } : {}),
  }]);
}

export function autoStartExternallyUnblockedReadyTasksImpl(host: SchedulerDomainHost): TaskState[] {
  const started = autoStartUnblockedTasksImpl(host);
  const readyTasks = host.stateMachine
    .getReadyTasks()
    .filter((task) => host.getExternalDependencyBlocker(task) === undefined);

  rebuildPendingLaunchQueue(host, readyTasks.map((task) => ({
    taskId: task.id,
    attemptId: task.execution.selectedAttemptId,
    priority: getCandidatePriority(host, task, 0),
  })));
  started.push(...drainSchedulerImpl(host));
  return started;
}

export function autoStartUnblockedTasksImpl(host: SchedulerDomainHost): TaskState[] {
  const candidateJobs: TaskJob[] = [];
  for (const task of host.stateMachine.getAllTasks()) {
    if (task.status !== 'blocked') continue;
    if (!areLocalDependenciesSatisfiedImpl(host, task)) continue;
    if (host.getExternalDependencyBlocker(task) !== undefined) continue;

    host.replaceSelectedAttempt(task, { status: 'pending' });
    const resetBefore = host.stateGetTask(task.id);
    if (!resetBefore) continue;
    const changes = buildTaskResetChanges('externalUnblock');
    const updated = host.writeAndSync(task.id, changes);
    assertResetComplete(resetBefore, updated, 'externalUnblock', { execution: changes.execution });
    const pendingTask = host.stateGetTask(task.id);
    if (!pendingTask) continue;
    candidateJobs.push({
      taskId: pendingTask.id,
      attemptId: pendingTask.execution.selectedAttemptId,
      priority: getCandidatePriority(host, pendingTask, 0),
    });
  }
  rebuildPendingLaunchQueue(host, candidateJobs);
  return drainSchedulerImpl(host);
}

export function getTaskLaunchReadinessImpl(
  host: SchedulerDomainHost,
  taskId: string,
  opts?: LaunchReadinessOptions,
): TaskLaunchReadiness {
  host.refreshFromDb();
  const task = host.stateGetTask(taskId);
  if (!task) {
    return { ready: false, reason: `task ${taskId} not found` };
  }
  if (task.status !== 'pending') {
    return { ready: false, reason: `task status is ${task.status}`, task };
  }

  if (!opts?.bypassLocalDependencyReadiness) {
    const localBlocker = getLocalDependencyBlockerImpl(host, task);
    if (localBlocker) {
      return { ready: false, reason: localBlocker, task };
    }
  }

  const externalBlocker = host.getExternalDependencyBlocker(task);
  if (externalBlocker) {
    return { ready: false, reason: externalBlocker, task };
  }

  return { ready: true, task };
}

export function areLocalDependenciesSatisfiedImpl(host: SchedulerDomainHost, task: TaskState): boolean {
  return getLocalDependencyBlockerImpl(host, task) === undefined;
}

export function getLocalDependencyBlockerImpl(host: SchedulerDomainHost, task: TaskState): string | undefined {
  for (const depId of task.dependencies) {
    const dep = host.stateGetTask(depId);
    if (!dep) return `missing dependency ${depId}`;
    const satisfied = task.config?.isReconciliation
      ? dep.status === 'completed' || dep.status === 'failed' || dep.status === 'closed' || dep.status === 'stale'
      : dep.status === 'completed' || dep.status === 'stale';
    if (!satisfied) {
      return `waiting on ${depId} (${dep.status})`;
    }
  }
  return undefined;
}

export function drainSchedulerImpl(host: SchedulerDomainHost): TaskState[] {
  const started: TaskState[] = [];
  const activeAttempts = host.countActivePersistedAttempts();
  let availableSlots = Math.max(0, host.maxConcurrency - activeAttempts);
  host.logger.info('[orchestrator] drainScheduler: begin', {
    active: activeAttempts,
    maxConcurrency: host.maxConcurrency,
    availableSlots,
  });
  let job = availableSlots > 0 ? host.scheduler.takeNext() : null;
  while (job && availableSlots > 0) {
    const readiness = getTaskLaunchReadinessImpl(host, job.taskId, {
      bypassLocalDependencyReadiness: job.bypassLocalDependencyReadiness,
    });
    host.logger.info('[orchestrator] drainScheduler: dequeued', {
      taskId: job.taskId,
      actualStatus: readiness.task?.status ?? 'NOT_FOUND',
    });
    if (!readiness.ready) {
      host.logger.info('[orchestrator] drainScheduler: skipping non-ready task', {
        taskId: job.taskId,
        reason: readiness.reason,
      });
      job = host.scheduler.takeNext();
      continue;
    }
    const task = readiness.task;

    const now = new Date();
    let attemptId = job.attemptId ?? host.ensureCurrentPendingAttempt(task);
    let currentAttempt = host.loadAttemptById(attemptId);
    if (!currentAttempt || isDiscardedAttempt(currentAttempt)) {
      attemptId = host.ensureCurrentPendingAttempt(task);
      currentAttempt = host.loadAttemptById(attemptId);
    }
    if (!currentAttempt || isDiscardedAttempt(currentAttempt)) {
      host.logger.info('[orchestrator] drainScheduler: skipping non-runnable attempt', {
        taskId: job.taskId,
        attemptId,
        attemptStatus: currentAttempt?.status ?? 'missing',
      });
      job = host.scheduler.takeNext();
      continue;
    }
    let launchAttemptId = attemptId;
    const selectedTask = host.stateGetTask(job.taskId) ?? task;
    if (selectedTask.execution.selectedAttemptId !== attemptId) {
      host.writeAndSync(job.taskId, { execution: { selectedAttemptId: attemptId } });
    }
    let claimSucceeded = false;
    const claimPatch = host.deferRunningUntilLaunch
      ? {
          status: 'claimed' as const,
          claimedAt: now,
          lastHeartbeatAt: now,
          leaseExpiresAt: nextLeaseExpiry(now),
        }
      : {
          status: 'running' as const,
          claimedAt: currentAttempt?.claimedAt ?? now,
          startedAt: now,
          lastHeartbeatAt: now,
          leaseExpiresAt: nextLeaseExpiry(now),
        };
    claimSucceeded = host.taskRepository.claimAttemptForLaunch?.(attemptId, claimPatch, now)
      ?? !host.isAttemptLeaseActive(currentAttempt, now.getTime());
    if (claimSucceeded && !host.taskRepository.claimAttemptForLaunch) {
      host.taskRepository.updateAttempt(attemptId, claimPatch);
    }
    if (!claimSucceeded) {
      host.logger.info('[orchestrator] drainScheduler: skipping already-claimed attempt', {
        taskId: job.taskId,
        attemptId,
      });
      job = availableSlots > 0 ? host.scheduler.takeNext() : null;
      continue;
    }

    const changes: TaskStateChanges = host.deferRunningUntilLaunch
      ? {
          status: 'pending',
          execution: {
            selectedAttemptId: launchAttemptId,
            generation: host.getExecutionGeneration(task),
            lastHeartbeatAt: now,
            phase: 'launching',
            launchStartedAt: now,
            launchCompletedAt: undefined,
          },
        }
      : {
          status: 'running',
          execution: {
            selectedAttemptId: launchAttemptId,
            generation: host.getExecutionGeneration(task),
            startedAt: now,
            lastHeartbeatAt: now,
            phase: 'launching',
            launchStartedAt: now,
            launchCompletedAt: undefined,
          },
        };
    const updated = host.writeAndSync(job.taskId, changes);
    host.persistence.logEvent?.(
      job.taskId,
      host.deferRunningUntilLaunch ? 'task.launch_claimed' : 'task.running',
      changes,
    );
    if (
      typeof host.persistence.enqueueLaunchDispatch === 'function'
      && task.config.workflowId
    ) {
      try {
        const dispatch = host.persistence.enqueueLaunchDispatch({
          taskId: job.taskId,
          attemptId: launchAttemptId,
          workflowId: task.config.workflowId,
          generation: host.getExecutionGeneration(task),
        });
        host.persistence.logEvent?.(job.taskId, 'task.dispatch_enqueued', {
          ...changes,
          dispatchId: dispatch.id,
          attemptId: launchAttemptId,
          workflowId: task.config.workflowId,
          generation: host.getExecutionGeneration(task),
          state: dispatch.state,
          priority: dispatch.priority,
        });
        host.logger.info('[orchestrator] drainScheduler: launch dispatch enqueued', {
          taskId: job.taskId,
          attemptId: launchAttemptId,
          workflowId: task.config.workflowId,
          generation: host.getExecutionGeneration(task),
          dispatchId: dispatch.id,
          state: dispatch.state,
          priority: dispatch.priority,
        });
      } catch (err) {
        host.logger.warn('[orchestrator] drainScheduler: enqueueLaunchDispatch failed', {
          taskId: job.taskId,
          attemptId: launchAttemptId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    host.messageBus.publish(TASK_DELTA_CHANNEL, host.buildUpdateDelta(task, updated, changes));
    started.push(updated);
    host.logger.info('[orchestrator] drainScheduler: started', {
      taskId: job.taskId,
      attemptId: launchAttemptId,
      phase: 'launching',
      generation: changes.execution?.generation ?? 'unknown',
    });

    availableSlots -= 1;
    job = availableSlots > 0 ? host.scheduler.takeNext() : null;
  }
  return started;
}
