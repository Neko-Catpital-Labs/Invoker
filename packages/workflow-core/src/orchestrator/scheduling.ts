import type { Logger } from '@invoker/contracts';
import type { Attempt, TaskDelta, TaskState, TaskStateChanges } from '@invoker/workflow-graph';
import { isDiscardedAttempt } from '../attempt-policy.js';
import type { OrchestratorMessageBus, OrchestratorPersistence } from '../orchestrator.js';
import type { TaskScheduler } from '../scheduler.js';
import type { TaskRepository } from '../task-repository.js';
import type { TaskStateMachine } from '../state-machine.js';
import { publishTaskDelta } from './events.js';
const ATTEMPT_LEASE_MS = 20 * 60 * 1000;

function nextLeaseExpiry(from: Date): Date {
  return new Date(from.getTime() + ATTEMPT_LEASE_MS);
}

export interface SchedulingHost {
  readonly stateMachine: TaskStateMachine;
  readonly scheduler: TaskScheduler;
  readonly persistence: OrchestratorPersistence;
  readonly messageBus: OrchestratorMessageBus;
  readonly taskRepository: TaskRepository;
  readonly logger: Logger;
  readonly maxConcurrency: number;
  readonly deferRunningUntilLaunch: boolean;
  readonly deferredTaskIds: Set<string>;

  stateGetTask(taskId: string): TaskState | undefined;
  writeAndSync(taskId: string, changes: TaskStateChanges): TaskState;
  buildUpdateDelta(before: TaskState, after: TaskState, changes: TaskStateChanges): TaskDelta;
  getExternalDependencyBlocker(task: TaskState): string | undefined;
  replaceSelectedAttempt(task: TaskState, opts?: Partial<Omit<Attempt, 'id' | 'nodeId' | 'createdAt'>>): string;
  ensureCurrentPendingAttempt(task: TaskState): string;
  loadAttemptById(attemptId: string | undefined): Attempt | undefined;
  isAttemptLeaseActive(attempt: Attempt | undefined, now?: number): boolean;
  countActivePersistedAttempts(): number;
  getExecutionGeneration(task: TaskState): number;
}

export function startExecutionDomain(host: SchedulingHost): TaskState[] {
  const activeAttempts = host.countActivePersistedAttempts();
  const readyTasks = host.stateMachine
    .getReadyTasks()
    .filter((task) => host.getExternalDependencyBlocker(task) === undefined);
  host.logger.info('[orchestrator] startExecution', {
    ready: readyTasks.length,
    active: activeAttempts,
    maxConcurrency: host.maxConcurrency,
    readyIds: readyTasks.map((task) => task.id),
  });

  for (const task of readyTasks) {
    enqueueIfNotScheduledDomain(host, task.id);
  }

  return drainSchedulerDomain(host);
}

export function autoStartReadyTasksDomain(
  host: SchedulingHost,
  taskIds: string[],
  priority = 0,
): TaskState[] {
  for (const taskId of taskIds) {
    let task = host.stateGetTask(taskId);
    if (!task) continue;
    if (host.getExternalDependencyBlocker(task) !== undefined) continue;

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

    enqueueIfNotScheduledDomain(host, taskId, priority);
  }

  return drainSchedulerDomain(host);
}

export function enqueueIfNotScheduledDomain(
  host: SchedulingHost,
  taskId: string,
  priority = 0,
): void {
  const task = host.stateGetTask(taskId);
  if (!task) return;

  const attemptId = host.ensureCurrentPendingAttempt(task);
  const currentAttempt = host.loadAttemptById(attemptId);
  if ((currentAttempt?.queuePriority ?? 0) !== priority) {
    host.taskRepository.updateAttempt(attemptId, { queuePriority: priority });
  }
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
    if (priority > queuedJob.priority) {
      host.scheduler.removeJob(queuedJob.attemptId ?? queuedJob.taskId);
      host.scheduler.enqueue({ taskId, attemptId, priority });
    }
    return;
  }
  host.scheduler.enqueue({ taskId, attemptId, priority });
}

export function autoStartExternallyUnblockedReadyTasksDomain(host: SchedulingHost): TaskState[] {
  const readyTasks = host.stateMachine
    .getReadyTasks()
    .filter((task) => (task.config.externalDependencies?.length ?? 0) > 0)
    .filter((task) => host.getExternalDependencyBlocker(task) === undefined);

  for (const task of readyTasks) {
    enqueueIfNotScheduledDomain(host, task.id);
  }
  return drainSchedulerDomain(host);
}

export function autoStartUnblockedTasksDomain(host: SchedulingHost): TaskState[] {
  for (const task of host.stateMachine.getAllTasks()) {
    if (task.status !== 'blocked') continue;
    if (!areLocalDependenciesSatisfiedDomain(host, task)) continue;
    if (host.getExternalDependencyBlocker(task) !== undefined) continue;

    host.replaceSelectedAttempt(task, { status: 'pending' });
    host.writeAndSync(task.id, {
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
    enqueueIfNotScheduledDomain(host, task.id);
  }
  return drainSchedulerDomain(host);
}

export function areLocalDependenciesSatisfiedDomain(host: SchedulingHost, task: TaskState): boolean {
  return task.dependencies.every((depId) => {
    const dep = host.stateGetTask(depId);
    if (!dep) return false;
    if (task.config?.isReconciliation) {
      return dep.status === 'completed' || dep.status === 'failed' || dep.status === 'stale';
    }
    return dep.status === 'completed' || dep.status === 'stale';
  });
}

export function drainSchedulerDomain(host: SchedulingHost): TaskState[] {
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
    const task = host.stateGetTask(job.taskId);
    host.logger.info('[orchestrator] drainScheduler: dequeued', {
      taskId: job.taskId,
      actualStatus: task?.status ?? 'NOT_FOUND',
    });
    if (!task || task.status !== 'pending') {
      host.logger.info('[orchestrator] drainScheduler: skipping non-pending task', {
        taskId: job.taskId,
      });
      job = host.scheduler.takeNext();
      continue;
    }

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
    const launchAttemptId = attemptId;
    const selectedTask = host.stateGetTask(job.taskId) ?? task;
    if (selectedTask.execution.selectedAttemptId !== attemptId) {
      host.writeAndSync(job.taskId, { execution: { selectedAttemptId: attemptId } });
    }
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
    const claimSucceeded = host.taskRepository.claimAttemptForLaunch?.(attemptId, claimPatch, now)
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
    publishTaskDelta(host, host.buildUpdateDelta(task, updated, changes));
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
