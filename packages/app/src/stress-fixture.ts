import type { SQLiteAdapter, Workflow } from '@invoker/data-store';
import { ATTEMPT_LEASE_MS, DISPATCH_LEASE_MS, LAUNCH_STUCK_ABANDON_MS } from '@invoker/contracts';
import { createAttempt, type TaskState } from '@invoker/workflow-core';
import {
  buildRecoveryWorkerAuditPayload,
  recoveryWorkerEventType,
} from './recovery-worker-observability.js';

const DEFAULT_NOW_ISO = '2026-07-01T00:00:00.000Z';
const DEFAULT_WORKFLOW_COUNT = 57;
const DEFAULT_TASKS_PER_WORKFLOW = 4;
const DEFAULT_EVENTS_PER_TASK = 0;

type PersistedTaskState = Omit<TaskState, 'status' | 'config' | 'execution'> & {
  status: TaskState['status'];
  config: TaskState['config'] & {
    workflowId?: string;
    runnerKind?: string;
    poolId?: string;
  };
  execution: TaskState['execution'] & {
    phase?: 'launching' | 'executing';
    launchStartedAt?: Date;
    launchCompletedAt?: Date;
  };
};

export interface StressFixtureOptions {
  workflowCount?: number;
  tasksPerWorkflow?: number;
  eventsPerTask?: number;
  nowIso?: string;
  stuckLaunchingSlots?: number;
  launchAgeMs?: number;
}

export interface StressFixtureResult {
  workflowCount: number;
  taskCount: number;
  running: number;
  launching: number;
  fixing: number;
  pending: number;
  failed: number;
}

function makeWorkflow(id: string, name: string, nowIso: string): Workflow {
  return {
    id,
    name,
    status: 'running',
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function makeBaseTask(id: string, workflowId: string, now: Date): PersistedTaskState {
  return {
    id,
    description: `Task ${id}`,
    status: 'pending',
    dependencies: [],
    createdAt: now,
    config: {
      workflowId,
      runnerKind: 'ssh',
      poolId: 'mixed-local-ssh',
    },
    execution: {
      generation: 0,
    },
    taskStateVersion: 1,
  };
}

function addRecoveryEvents(
  persistence: Pick<SQLiteAdapter, 'logEvent'>,
  taskId: string,
  workflowId: string,
  eventsPerTask: number,
): void {
  for (let e = 0; e < eventsPerTask; e += 1) {
    const action = e % 4 === 0
      ? 'wakeup'
      : e % 4 === 1
        ? 'scan'
        : e % 4 === 2
          ? 'submit'
          : 'skip';
    persistence.logEvent(
      taskId,
      recoveryWorkerEventType(action),
      buildRecoveryWorkerAuditPayload(action, `${action}-phase`, {
        workflowId,
        reason: action === 'skip' ? 'budget' : undefined,
      }),
    );
  }
}

function withLeasedAttempt(taskId: string, status: 'claimed' | 'running', now: Date) {
  return createAttempt(taskId, {
    status,
    claimedAt: now,
    startedAt: status === 'running' ? now : undefined,
    lastHeartbeatAt: now,
    leaseExpiresAt: new Date(now.getTime() + ATTEMPT_LEASE_MS),
  });
}
function backdateDispatchRow(
  persistence: Pick<SQLiteAdapter, 'enqueueLaunchDispatch' | 'claimLaunchDispatchAtomic'>,
  dispatchId: number,
  enqueuedAt: string,
  fencedUntil: string,
): void {
  const db = (persistence as unknown as { db: { run: (sql: string, params: unknown[]) => void } }).db;
  db.run(
    `UPDATE task_launch_dispatch
        SET enqueued_at = ?, leased_at = ?, fenced_until = ?, attempts_count = 1
      WHERE id = ?`,
    [enqueuedAt, enqueuedAt, fencedUntil, dispatchId],
  );
}

function seedStuckLaunchingDispatch(
  persistence: Pick<SQLiteAdapter, 'enqueueLaunchDispatch' | 'claimLaunchDispatchAtomic'>,
  workflowId: string,
  taskId: string,
  attemptId: string,
  now: Date,
  launchAgeMs: number,
): void {
  const claimTime = new Date(now.getTime() - DISPATCH_LEASE_MS - 60_000);
  const dispatch = persistence.enqueueLaunchDispatch({
    taskId,
    attemptId,
    workflowId,
    generation: 0,
  });
  persistence.claimLaunchDispatchAtomic({
    ownerId: 'stress-fixture-owner',
    nowIso: claimTime.toISOString(),
  });
  backdateDispatchRow(
    persistence,
    dispatch.id,
    new Date(now.getTime() - launchAgeMs - 1_000).toISOString(),
    new Date(claimTime.getTime() + DISPATCH_LEASE_MS).toISOString(),
  );
}


function classifyState(taskIndex: number): 'running' | 'launching' | 'fixing' | 'pending' | 'failed' {
  if (taskIndex % 10 === 9) {
    return 'failed';
  }
  switch (taskIndex % 4) {
    case 0:
      return 'running';
    case 1:
      return 'launching';
    case 2:
      return 'fixing';
    default:
      return 'pending';
  }
}

export function seedStressFixture(
  persistence: Pick<
    SQLiteAdapter,
    | 'saveWorkflow'
    | 'saveTask'
    | 'saveAttempt'
    | 'logEvent'
    | 'enqueueLaunchDispatch'
    | 'claimLaunchDispatchAtomic'
  >,
  options: StressFixtureOptions = {},
): StressFixtureResult {
  const workflowCount = options.workflowCount ?? DEFAULT_WORKFLOW_COUNT;
  const tasksPerWorkflow = options.tasksPerWorkflow ?? DEFAULT_TASKS_PER_WORKFLOW;
  const eventsPerTask = options.eventsPerTask ?? DEFAULT_EVENTS_PER_TASK;
  const stuckLaunchingSlots = options.stuckLaunchingSlots ?? 0;
  const launchAgeMs = options.launchAgeMs ?? LAUNCH_STUCK_ABANDON_MS;
  const nowIso = options.nowIso ?? DEFAULT_NOW_ISO;
  const now = new Date(nowIso);
  const result: StressFixtureResult = {
    workflowCount,
    taskCount: workflowCount * tasksPerWorkflow,
    running: 0,
    launching: 0,
    fixing: 0,
    pending: 0,
    failed: 0,
  };
  let seededStuckLaunchingSlots = 0;


  for (let workflowIndex = 0; workflowIndex < workflowCount; workflowIndex += 1) {
    const workflowId = `wf-stress-${workflowIndex}`;
    persistence.saveWorkflow(makeWorkflow(workflowId, `Stress workflow ${workflowIndex}`, nowIso));
    for (let taskIndex = 0; taskIndex < tasksPerWorkflow; taskIndex += 1) {
      const taskId = `${workflowId}/t${taskIndex}`;
      const task = makeBaseTask(taskId, workflowId, now);
      switch (classifyState(taskIndex)) {
        case 'running': {
          const attempt = withLeasedAttempt(taskId, 'running', now);
          task.status = 'running';
          task.execution = {
            ...task.execution,
            phase: 'executing',
            startedAt: now,
            lastHeartbeatAt: now,
            selectedAttemptId: attempt.id,
          };
          persistence.saveTask(workflowId, task);
          persistence.saveAttempt(attempt);
          result.running += 1;
          break;
        }
        case 'launching': {
          const attempt = withLeasedAttempt(taskId, 'claimed', now);
          task.execution = {
            ...task.execution,
            phase: 'launching',
            launchStartedAt: now,
            lastHeartbeatAt: now,
            selectedAttemptId: attempt.id,
          };
          persistence.saveTask(workflowId, task);
          persistence.saveAttempt(attempt);
          if (seededStuckLaunchingSlots < stuckLaunchingSlots) {
            seedStuckLaunchingDispatch(
              persistence,
              workflowId,
              taskId,
              attempt.id,
              now,
              launchAgeMs,
            );
            seededStuckLaunchingSlots += 1;
          }
          result.launching += 1;
          break;
        }
        case 'fixing': {
          const attempt = withLeasedAttempt(taskId, 'running', now);
          task.status = 'fixing_with_ai';
          task.execution = {
            ...task.execution,
            phase: 'executing',
            startedAt: now,
            lastHeartbeatAt: now,
            isFixingWithAI: true,
            agentSessionId: `${taskId}-session`,
            agentName: 'stress-agent',
            selectedAttemptId: attempt.id,
          };
          persistence.saveTask(workflowId, task);
          persistence.saveAttempt(attempt);
          result.fixing += 1;
          break;
        }
        case 'failed':
          task.status = 'failed';
          result.failed += 1;
          break;
        case 'pending':
          result.pending += 1;
          break;
      }
      persistence.saveTask(workflowId, task);
      addRecoveryEvents(persistence, taskId, workflowId, eventsPerTask);
    }
  }

  return result;
}
