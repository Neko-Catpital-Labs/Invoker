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
import { ATTEMPT_LEASE_MS } from '@invoker/contracts';
import type { Logger } from '@invoker/contracts';
import { isDiscardedAttempt } from '../attempt-policy.js';
import type { TaskStateMachine } from '../state-machine.js';
import type { TaskScheduler } from '../scheduler.js';
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

// ── Extracted Functions ─────────────────────────────────────

export function autoStartReadyTasksImpl(
  host: SchedulerDomainHost,
  taskIds: string[],
  priority: number = 0,
  opts?: LaunchReadinessOptions,
): TaskState[] {
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
      host.writeAndSync(taskId, {
        status: 'pending',
        execution: {
          startedAt: undefined,
          completedAt: undefined,
          lastHeartbeatAt: undefined,
          launchStartedAt: undefined,
          launchCompletedAt: undefined,
          phase: undefined,
        },
      });
      task = host.stateGetTask(taskId);
      if (!task) continue;
    }

    enqueueIfNotScheduledImpl(host, taskId, priority, opts);
  }

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

  const attemptId = host.ensureCurrentPendingAttempt(task);
  const currentAttempt = host.loadAttemptById(attemptId);
  if ((currentAttempt?.queuePriority ?? 0) !== priority) {
    host.taskRepository.updateAttempt(attemptId, { queuePriority: priority });
  }
  // A task can be force-set back to blocked/pending by recovery logic while
  // still carrying a stale selectedAttemptId from an older run. Only skip
  // re-enqueue when the task is actually active.
  if (
    (task.status === 'running' || task.status === 'fixing_with_ai') &&
    task.execution.selectedAttemptId === attemptId &&
    host.isAttemptLeaseActive(currentAttempt)
  ) {
    return;
  }
  const queuedJob = host.scheduler
    .getQueuedJobs()
    .find((job) => job.attemptId === attemptId || job.taskId === taskId);
  if (queuedJob) {
    const shouldReplaceQueuedJob =
      priority > queuedJob.priority ||
      (opts?.bypassLocalDependencyReadiness === true && !queuedJob.bypassLocalDependencyReadiness);
    if (shouldReplaceQueuedJob) {
      host.scheduler.removeJob(queuedJob.attemptId ?? queuedJob.taskId);
      host.scheduler.enqueue({
        taskId,
        attemptId,
        priority: Math.max(priority, queuedJob.priority),
        ...(opts?.bypassLocalDependencyReadiness ? { bypassLocalDependencyReadiness: true } : {}),
      });
    }
    return;
  }
  host.scheduler.enqueue({
    taskId,
    attemptId,
    priority,
    ...(opts?.bypassLocalDependencyReadiness ? { bypassLocalDependencyReadiness: true } : {}),
  });
}

export function autoStartExternallyUnblockedReadyTasksImpl(host: SchedulerDomainHost): TaskState[] {
  const started = autoStartUnblockedTasksImpl(host);
  const readyTasks = host.stateMachine
    .getReadyTasks()
    .filter((task) => host.getExternalDependencyBlocker(task) === undefined);

  for (const task of readyTasks) {
    enqueueIfNotScheduledImpl(host, task.id);
  }
  started.push(...drainSchedulerImpl(host));
  return started;
}

export function autoStartUnblockedTasksImpl(host: SchedulerDomainHost): TaskState[] {
  for (const task of host.stateMachine.getAllTasks()) {
    if (task.status !== 'blocked') continue;
    if (!areLocalDependenciesSatisfiedImpl(host, task)) continue;
    if (host.getExternalDependencyBlocker(task) !== undefined) continue;

    host.replaceSelectedAttempt(task, { status: 'pending' });
    host.writeAndSync(task.id, {
      status: 'pending',
      execution: {
        blockedBy: undefined,
        startedAt: undefined,
        completedAt: undefined,
        lastHeartbeatAt: undefined,
        launchStartedAt: undefined,
        launchCompletedAt: undefined,
        phase: undefined,
      },
    });
    enqueueIfNotScheduledImpl(host, task.id);
  }
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
