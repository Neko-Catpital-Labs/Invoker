import type { SQLiteAdapter, Workflow, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import { ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS, PR_MAINTENANCE_AUTO_STARTED_WORKER_KINDS } from './worker-control.js';
import {
  buildRecoveryWorkerAuditPayload,
  recoveryWorkerEventType,
} from './recovery-worker-observability.js';

export const MAIN_PROCESS_HITCH_FIXTURE_WORKFLOW_ID = 'wf-hitch-fat';

const DEFAULT_TASK_COUNT = 40;
const DEFAULT_EVENTS_PER_TASK = 250;
const DEFAULT_ACTIONS_PER_KIND = 80;

const ACTION_WORKER_KINDS = [
  'autofix',
  ...ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS,
  ...PR_MAINTENANCE_AUTO_STARTED_WORKER_KINDS,
] as const;

export interface MainProcessHitchFixtureOptions {
  taskCount?: number;
  eventsPerTask?: number;
  actionsPerKind?: number;
  /** Defaults to completed so dbPoll does not keep syncing a perpetual running workflow. */
  workflowStatus?: Workflow['status'];
}

export interface MainProcessHitchFixtureResult {
  workflowId: string;
  taskCount: number;
  eventCount: number;
  workerActionCount: number;
}

function makeWorkflow(id: string, name: string, status: Workflow['status']): Workflow {
  return {
    id,
    name,
    status,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function makeTask(id: string): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    config: {},
    execution: {},
    taskStateVersion: 1,
  };
}

export function seedMainProcessHitchFixture(
  persistence: Pick<SQLiteAdapter, 'saveWorkflow' | 'saveTask' | 'logEvent' | 'upsertWorkerAction' | 'runInTransaction'>,
  options: MainProcessHitchFixtureOptions = {},
): MainProcessHitchFixtureResult {
  const taskCount = options.taskCount ?? DEFAULT_TASK_COUNT;
  const eventsPerTask = options.eventsPerTask ?? DEFAULT_EVENTS_PER_TASK;
  const actionsPerKind = options.actionsPerKind ?? DEFAULT_ACTIONS_PER_KIND;
  const workflowStatus = options.workflowStatus ?? 'completed';
  const workflowId = MAIN_PROCESS_HITCH_FIXTURE_WORKFLOW_ID;
  let workerActionCount = 0;

  persistence.runInTransaction(() => {
    persistence.saveWorkflow(makeWorkflow(workflowId, 'Main-process hitch fixture', workflowStatus));

    for (let t = 0; t < taskCount; t += 1) {
      const taskId = `${workflowId}/t${t}`;
      persistence.saveTask(workflowId, makeTask(taskId));
      for (let e = 0; e < eventsPerTask; e += 1) {
        const action = e % 4 === 0 ? 'wakeup'
          : e % 4 === 1 ? 'scan'
            : e % 4 === 2 ? 'submit'
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

    for (const workerKind of ACTION_WORKER_KINDS) {
      for (let i = 0; i < actionsPerKind; i += 1) {
        const taskId = `${workflowId}/t${i % Math.max(taskCount, 1)}`;
        const write: WorkerActionWrite = {
          id: `wa-hitch-${workerKind}-${i}`,
          workerKind,
          actionType: 'hitch-fixture',
          workflowId,
          taskId,
          subjectType: 'task',
          subjectId: taskId,
          externalKey: `hitch:${workerKind}:${i}`,
          status: i % 5 === 0 ? 'skipped' : 'completed',
          attemptCount: 1,
          summary: `Hitch fixture ${workerKind} ${i}`,
          payload: { reason: i % 5 === 0 ? 'budget' : 'ok' },
          createdAt: `2026-07-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
          updatedAt: `2026-07-01T00:01:${String(i % 60).padStart(2, '0')}.000Z`,
        };
        persistence.upsertWorkerAction(write);
        workerActionCount += 1;
      }
    }
  });

  return {
    workflowId,
    taskCount,
    eventCount: taskCount * eventsPerTask,
    workerActionCount,
  };
}
