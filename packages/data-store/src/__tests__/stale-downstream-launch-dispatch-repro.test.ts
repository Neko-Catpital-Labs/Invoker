import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
import type { TaskState } from '@invoker/workflow-core';

const WORKFLOW_ID = 'wf-stale-downstream-dispatch';
const UPSTREAM_ID = `${WORKFLOW_ID}/verify`;
const MERGE_ID = `__merge__${WORKFLOW_ID}`;

function makeWorkflow(): Workflow {
  const now = new Date('2026-06-03T00:00:00.000Z').toISOString();
  return {
    id: WORKFLOW_ID,
    name: 'stale downstream dispatch repro',
    status: 'running',
    createdAt: now,
    updatedAt: now,
  };
}

function makeTask(
  id: string,
  overrides: Partial<TaskState> = {},
): TaskState {
  const {
    config: overrideConfig,
    execution: overrideExecution,
    ...rest
  } = overrides;
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-06-03T00:00:00.000Z'),
    taskStateVersion: 1,
    ...rest,
    config: {
      workflowId: WORKFLOW_ID,
      ...overrideConfig,
    },
    execution: {
      ...overrideExecution,
    },
  };
}

describe('stale downstream launch dispatch repro', () => {
  let adapter: SQLiteAdapter | undefined;
  let cleanupDir: string | undefined;

  afterEach(() => {
    adapter?.close();
    adapter = undefined;
    if (cleanupDir) {
      rmSync(cleanupDir, { recursive: true, force: true });
      cleanupDir = undefined;
    }
  });

  async function createAdapter(): Promise<SQLiteAdapter> {
    const reproDbPath = process.env.INVOKER_STALE_DISPATCH_REPRO_DB_PATH;
    if (reproDbPath) {
      rmSync(reproDbPath, { force: true });
      return SQLiteAdapter.create(reproDbPath, { ownerCapability: true });
    }
    cleanupDir = mkdtempSync(join(tmpdir(), 'invoker-stale-dispatch-repro-'));
    return SQLiteAdapter.create(join(cleanupDir, 'invoker.db'), { ownerCapability: true });
  }

  it('does not lease a stale merge gate dispatch after its prerequisite reverts to pending', async () => {
    adapter = await createAdapter();
    adapter.saveWorkflow(makeWorkflow());

    adapter.saveTask(
      WORKFLOW_ID,
      makeTask(UPSTREAM_ID, {
        status: 'completed',
        execution: {
          generation: 1,
          selectedAttemptId: `${UPSTREAM_ID}-attempt-1`,
          completedAt: new Date('2026-06-03T00:01:00.000Z'),
          commit: 'old-green-commit',
        },
      }),
    );
    adapter.saveTask(
      WORKFLOW_ID,
      makeTask(MERGE_ID, {
        status: 'pending',
        dependencies: [UPSTREAM_ID],
        config: {
          workflowId: WORKFLOW_ID,
          isMergeNode: true,
        },
        execution: {
          generation: 1,
          selectedAttemptId: `${MERGE_ID}-attempt-1`,
        },
      }),
    );

    const staleDispatch = adapter.enqueueLaunchDispatch({
      taskId: MERGE_ID,
      attemptId: `${MERGE_ID}-attempt-1`,
      workflowId: WORKFLOW_ID,
      generation: 1,
    });

    // This models retry/recreate of the upstream verification after the
    // downstream merge gate had already been enqueued. The downstream task
    // receives a fresh generation and selected attempt, but the old outbox
    // dispatch row is still present.
    adapter.updateTask(UPSTREAM_ID, {
      status: 'pending',
      execution: {
        generation: 2,
        selectedAttemptId: `${UPSTREAM_ID}-attempt-2`,
        completedAt: undefined,
        commit: undefined,
      },
    });
    adapter.updateTask(MERGE_ID, {
      status: 'pending',
      execution: {
        generation: 2,
        selectedAttemptId: `${MERGE_ID}-attempt-2`,
      },
    });
    adapter.logEvent?.(UPSTREAM_ID, 'task.pending', {
      status: 'pending',
      execution: { generation: 2, selectedAttemptId: `${UPSTREAM_ID}-attempt-2` },
    });

    const leased = adapter.claimLaunchDispatchAtomic({
      ownerId: 'repro-owner',
      nowIso: '2026-06-03T00:02:00.000Z',
    });

    expect(leased, [
      'The stale merge dispatch must be invalidated or skipped before lease.',
      `dispatch=${staleDispatch.id}`,
      `upstream=${UPSTREAM_ID} is pending`,
      `merge task selected attempt is ${MERGE_ID}-attempt-2`,
      `dispatch attempt is ${MERGE_ID}-attempt-1`,
    ].join(' ')).toBeUndefined();

    const invalidated = adapter.getEvents(MERGE_ID).find(
      (event) => event.eventType === 'task.launch_dispatch_invalidated',
    );
    expect(invalidated).toBeDefined();
    expect(JSON.parse(invalidated!.payload!)).toMatchObject({
      dispatchId: staleDispatch.id,
      dispatchAttemptId: `${MERGE_ID}-attempt-1`,
      reason: 'selected_attempt_changed',
      currentSelectedAttemptId: `${MERGE_ID}-attempt-2`,
      currentExecutionGeneration: 2,
    });
  });
});
