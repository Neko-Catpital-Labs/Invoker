import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import { InMemoryPersistence, InMemoryBus } from './helpers/cross-workflow-cascade-helpers.js';

describe('queue status UI cache can drift from the DB', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a newly-created queued task must not be invisible to the UI cache', () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = new Orchestrator({
      persistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 2,
    });

    orchestrator.loadPlan({
      name: 'ui-cache-drift-1',
      baseBranch: 'master',
      featureBranch: 'feature/ui-cache-drift-1',
      tasks: [
        { id: 'a', description: 'Task A' },
        { id: 'b', description: 'Task B' },
      ],
    });

    // 1. A UI poll (refresh:false, exactly what the renderer's queue-status
    // hook sends) lands now and seeds the 200ms cache.
    const uiBeforeNewPlan = orchestrator.getQueueStatus({ refresh: false });
    expect(uiBeforeNewPlan.queued.length).toBe(2);

    // 2. A second workflow lands moments later (e.g. a recreated/retried
    // workflow) and its ready task is written straight to the DB via
    // createAndSync, which — unlike writeAndSync — never invalidates
    // queueStatusUiCache.
    orchestrator.loadPlan({
      name: 'ui-cache-drift-2',
      baseBranch: 'master',
      featureBranch: 'feature/ui-cache-drift-2',
      tasks: [{ id: 'c', description: 'Task C' }],
    });

    // Ground truth: read straight off the persisted/in-memory task state,
    // no cache involved. This is literally what's in the DB right now.
    const dbPendingCount = orchestrator.getAllTasks()
      .filter((t) => !t.config.isMergeNode && t.status === 'pending').length;
    expect(dbPendingCount).toBe(3);

    // 3. The next UI poll lands 50ms later — still inside the 200ms cache
    // window — and reuses the pre-plan-2 snapshot. Task C is invisible.
    vi.advanceTimersByTime(50);
    const uiStillPolling = orchestrator.getQueueStatus({ refresh: false });
    console.log(`[drift-check] UI shows queued count: ${uiStillPolling.queued.length}`);
    console.log(`[drift-check] DB shows pending/ready count: ${dbPendingCount}`);

    // The UI must reflect the DB immediately on a task-creating write, not
    // up to 200ms later.
    expect(uiStillPolling.queued.length).toBe(dbPendingCount);
  });

  it('rebase-recreate on a failed workflow: UI (getQueueStatus) vs raw persisted task rows', async () => {
    const persistence = new InMemoryPersistence();
    const orchestrator = new Orchestrator({
      persistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 2,
    });

    orchestrator.loadPlan({
      name: 'rebase-recreate-drift-check',
      baseBranch: 'master',
      featureBranch: 'feature/rebase-recreate-drift-check',
      tasks: [
        { id: 'a', description: 'Task A' },
        { id: 'b', description: 'Task B', dependencies: ['a'] },
      ],
    });

    orchestrator.startExecution();

    const taskAId = orchestrator.getAllTasks().find((t) => t.id.endsWith('/a'))!.id;
    const workflowId = taskAId.split('/')[0]!;

    expect(orchestrator.getTask(taskAId)!.status).toBe('running');

    // Task A fails, exactly like discover-delete-scope did in the real
    // wf-1784951074087-1 workflow.
    orchestrator.handleWorkerResponse({
      requestId: 'req-fail',
      actionId: taskAId,
      executionGeneration: 0,
      status: 'failed',
      outputs: { exitCode: 1 },
    });

    expect(orchestrator.getTask(taskAId)!.status).toBe('failed');

    // A "UI poll" (refresh:false) lands right after the failure and seeds
    // the cache: 0 running, workflow shows failed.
    const uiBeforeRecreate = orchestrator.getQueueStatus({ refresh: false });
    expect(uiBeforeRecreate.runningCount).toBe(0);

    // rebase-recreate = "refresh pool base, then recreate workflow"
    // (packages/app/src/headless-usage.ts). No real git remote here, so
    // refreshBase is a no-op — the orchestrator-level effect is identical.
    await orchestrator.recreateWorkflowFromFreshBase(workflowId, { refreshBase: async () => undefined });

    // "sqlite" ground truth: read the persisted task row directly, bypassing
    // the orchestrator's in-memory state machine and its cache entirely.
    const rawPersistedTaskA = persistence.getTaskEntry(taskAId)!.task;
    console.log(`[rebase-recreate] sqlite row for ${taskAId}: status=${rawPersistedTaskA.status}`);

    // "invoker query" — same call the CLI's `query tasks` makes.
    const queriedTaskA = orchestrator.getTask(taskAId)!;
    console.log(`[rebase-recreate] invoker query status for ${taskAId}: status=${queriedTaskA.status}`);

    // The UI queue chip, read with the exact same refresh:false poll that
    // was in-flight before the recreate.
    const uiAfterRecreate = orchestrator.getQueueStatus({ refresh: false });
    console.log(`[rebase-recreate] UI queue chip runningCount: ${uiAfterRecreate.runningCount} (cache age 0ms)`);

    // Claim under test: does the UI ever show "not running" while sqlite and
    // invoker query already show "running"?
    expect(rawPersistedTaskA.status).toBe(queriedTaskA.status);
    expect(uiAfterRecreate.runningCount).toBe(1);
    expect(queriedTaskA.status).toBe('running');
  });
});
