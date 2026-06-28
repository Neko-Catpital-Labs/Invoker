import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { DISPATCH_LEASE_MS, type Logger } from '@invoker/contracts';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import { LaunchDispatcher } from '../launch-dispatcher.js';

function makeLogger(): Logger & {
  records: { level: 'info' | 'warn' | 'error' | 'debug'; msg: string; fields?: Record<string, unknown> }[];
} {
  const records: { level: 'info' | 'warn' | 'error' | 'debug'; msg: string; fields?: Record<string, unknown> }[] = [];
  const push = (level: 'info' | 'warn' | 'error' | 'debug') =>
    (msg: string, fields?: Record<string, unknown>) => {
      records.push({ level, msg, fields });
    };
  const logger: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return Object.assign(logger, { records });
}

describe('LaunchDispatcher', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('constructs with a real SQLiteAdapter without throwing', () => {
    expect(() => new LaunchDispatcher({
      persistence: adapter,
      ownerId: 'owner-test',
    })).not.toThrow();
  });


  it('without a taskRunnerProvider warns and does not dispatch', () => {
    const claimSpy = vi.spyOn(adapter, 'claimLaunchDispatchAtomic');
    const logger = makeLogger();
    const dispatcher = new LaunchDispatcher({
      persistence: adapter,
      ownerId: 'owner-test',
      logger,
    });
    expect(() => dispatcher.poll()).not.toThrow();
    expect(claimSpy).not.toHaveBeenCalled();
    const warn = logger.records.find((entry) => entry.level === 'warn');
    expect(warn?.msg).toMatch(/without taskRunner/);
    claimSpy.mockRestore();
  });


  describe('complete / fail transitions', () => {
    function seedWorkflowAndTask(selectedAttemptId?: string): void {
      adapter.saveWorkflow({ id: 'wf-1',
      name: 'wf-1', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), });
      adapter.saveTask('wf-1', {
        id: 'wf-1/t1',
        description: 'one',
        status: 'pending',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: 'wf-1' },
        execution: {},
        taskStateVersion: 1,
      });
      if (selectedAttemptId) {
        adapter.updateTask('wf-1/t1', {
          execution: { selectedAttemptId, generation: 0 },
        });
      }
    }

    function makeDispatcher(logger = makeLogger()) {
      return {
        logger,
        dispatcher: new LaunchDispatcher({
          persistence: adapter,
          ownerId: 'owner-test',
          logger,
        }),
      };
    }

    it('complete moves a live row to completed', () => {
      seedWorkflowAndTask();
      const enqueued = adapter.enqueueLaunchDispatch({
        taskId: 'wf-1/t1',
        attemptId: 'attempt-complete',
        workflowId: 'wf-1',
        generation: 0,
      });

      const { dispatcher, logger } = makeDispatcher();
      expect(dispatcher.completeDispatch(enqueued.id)).toBe(true);

      const after = adapter.loadLaunchDispatchById(enqueued.id);
      expect(after?.state).toBe('completed');

      const log = logger.records.find((entry) => entry.msg.includes('complete'));
      expect(log?.fields?.accepted).toBe(true);
    });

    it('complete returns false on an already-terminal row', () => {
      seedWorkflowAndTask();
      const enqueued = adapter.enqueueLaunchDispatch({
        taskId: 'wf-1/t1',
        attemptId: 'attempt-complete-twice',
        workflowId: 'wf-1',
        generation: 0,
      });
      const { dispatcher } = makeDispatcher();
      expect(dispatcher.completeDispatch(enqueued.id)).toBe(true);
      expect(dispatcher.completeDispatch(enqueued.id)).toBe(false);
    });

    it('uses a fixed dispatch TTL long enough for normal executor startup', () => {
      seedWorkflowAndTask('attempt-fixed-ttl');
      const enqueued = adapter.enqueueLaunchDispatch({
        taskId: 'wf-1/t1',
        attemptId: 'attempt-fixed-ttl',
        workflowId: 'wf-1',
        generation: 0,
      });
      const claimedAt = '2026-06-04T22:38:44.000Z';
      const claimed = adapter.claimLaunchDispatchAtomic({
        ownerId: 'owner-test',
        nowIso: claimedAt,
      });
      expect(claimed?.id).toBe(enqueued.id);
      expect(claimed?.fencedUntil).toBe(
        new Date(new Date(claimedAt).getTime() + DISPATCH_LEASE_MS).toISOString(),
      );

      const { dispatcher } = makeDispatcher();
      expect(dispatcher.reapExpiredLeases(
        new Date(new Date(claimedAt).getTime() + DISPATCH_LEASE_MS - 1).toISOString(),
      )).toBe(0);
      expect(adapter.loadLaunchDispatchById(enqueued.id)?.state).toBe('leased');
      expect(dispatcher.reapExpiredLeases(
        new Date(new Date(claimedAt).getTime() + DISPATCH_LEASE_MS + 1).toISOString(),
      )).toBe(1);
      expect(adapter.loadLaunchDispatchById(enqueued.id)?.state).toBe('enqueued');
    });

    it('fail re-enqueues a leased row with the error message and clears the owner', () => {
      seedWorkflowAndTask('attempt-fail');
      const enqueued = adapter.enqueueLaunchDispatch({
        taskId: 'wf-1/t1',
        attemptId: 'attempt-fail',
        workflowId: 'wf-1',
        generation: 0,
      });
      adapter.claimLaunchDispatchAtomic({
        ownerId: 'owner-test',
      });

      const { dispatcher } = makeDispatcher();
      expect(dispatcher.failDispatch(enqueued.id, new Error('boom'))).toBe(true);

      const after = adapter.loadLaunchDispatchById(enqueued.id);
      expect(after?.state).toBe('enqueued');
      expect(after?.lastError).toBe('boom');
      expect(after?.dispatchOwner).toBeUndefined();
      expect(after?.fencedUntil).toBeUndefined();
    });
    it('fail abandons after fast failures reach the dispatch retry limit', () => {
      seedWorkflowAndTask('attempt-fast-fail');
      const enqueued = adapter.enqueueLaunchDispatch({
        taskId: 'wf-1/t1',
        attemptId: 'attempt-fast-fail',
        workflowId: 'wf-1',
        generation: 0,
      });
      adapter.claimLaunchDispatchAtomic({
        ownerId: 'owner-test',
      });
      const prepare = vi.fn();
      const dispatcher = new LaunchDispatcher({
        persistence: adapter,
        ownerId: 'owner-test',
        maxAttempts: 1,
        orchestrator: {
          prepareTaskForNewAttempt: prepare,
        },
      });

      expect(dispatcher.failDispatch(enqueued.id, new Error('ssh pool unavailable'))).toBe(true);

      const after = adapter.loadLaunchDispatchById(enqueued.id);
      expect(after?.state).toBe('abandoned');
      expect(after?.lastError).toMatch(/ssh pool unavailable/);
      expect(prepare).not.toHaveBeenCalled();
      expect(adapter.getEvents('wf-1/t1').some((event) => event.eventType === 'task.failed')).toBe(false);
    });

    it('fail coerces a non-Error value to its string form', () => {
      seedWorkflowAndTask('attempt-fail-string');
      const enqueued = adapter.enqueueLaunchDispatch({
        taskId: 'wf-1/t1',
        attemptId: 'attempt-fail-string',
        workflowId: 'wf-1',
        generation: 0,
      });
      adapter.claimLaunchDispatchAtomic({
        ownerId: 'owner-test',
      });

      const { dispatcher } = makeDispatcher();
      expect(dispatcher.failDispatch(enqueued.id, 'plain string')).toBe(true);
      const after = adapter.loadLaunchDispatchById(enqueued.id);
      expect(after?.lastError).toBe('plain string');
    });

    it('fail returns false on a row that is already terminal', () => {
      seedWorkflowAndTask();
      const enqueued = adapter.enqueueLaunchDispatch({
        taskId: 'wf-1/t1',
        attemptId: 'attempt-fail-terminal',
        workflowId: 'wf-1',
        generation: 0,
      });
      adapter.markLaunchDispatchCompleted(enqueued.id);

      const { dispatcher } = makeDispatcher();
      expect(dispatcher.failDispatch(enqueued.id, 'too late')).toBe(false);
    });
  });

  describe('reapers', () => {
    function seed(): void {
      adapter.saveWorkflow({ id: 'wf-r',
      name: 'wf-r', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), });
      adapter.saveTask('wf-r', {
        id: 'wf-r/t1',
        description: 't1',
        status: 'pending',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: 'wf-r' },
        execution: {},
        taskStateVersion: 1,
      });
    }

    function dispatcherWithOrchestrator(orchestrator?: { prepareTaskForNewAttempt: ReturnType<typeof vi.fn> }) {
      const logger = makeLogger();
      const dispatcher = new LaunchDispatcher({
        persistence: adapter,
        orchestrator,
        ownerId: 'owner-test',
        logger,
        maxAttempts: 2,
      });
      return { dispatcher, logger };
    }

    it('reapExpiredLeases resets stale leased rows and emits an audit event per row', () => {
      seed();
      const row = adapter.enqueueLaunchDispatch({
        taskId: 'wf-r/t1',
        attemptId: 'attempt-reap',
        workflowId: 'wf-r',
        generation: 0,
      });
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch SET state = 'leased', dispatch_owner = 'owner-x', fenced_until = ? WHERE id = ?`,
        [pastIso, row.id],
      );

      const { dispatcher } = dispatcherWithOrchestrator();
      const reaped = dispatcher.reapExpiredLeases();

      expect(reaped).toBe(1);
      expect(adapter.loadLaunchDispatchById(row.id)?.state).toBe('enqueued');
      const events = adapter.getEvents('wf-r/t1');
      const reapEvent = events.find((event) => event.eventType === 'task.launch_dispatch_reaped');
      expect(reapEvent).toBeDefined();
      expect(JSON.parse(reapEvent!.payload!)).toMatchObject({
        dispatchId: row.id,
        reason: 'lease_expired',
      });
    });

    it('reapExpiredLeases is a no-op when nothing is stale', () => {
      seed();
      const { dispatcher } = dispatcherWithOrchestrator();
      expect(dispatcher.reapExpiredLeases()).toBe(0);
    });

    it('abandonStuckLeases abandons leased rows past max attempts and calls prepareTaskForNewAttempt', () => {
      seed();
      const row = adapter.enqueueLaunchDispatch({
        taskId: 'wf-r/t1',
        attemptId: 'attempt-abandon',
        workflowId: 'wf-r',
        generation: 0,
      });
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch
           SET state = 'leased', dispatch_owner = 'owner-x',
               fenced_until = ?, attempts_count = 2, last_error = 'startup error'
         WHERE id = ?`,
        [pastIso, row.id],
      );

      const prepare = vi.fn();
      const { dispatcher } = dispatcherWithOrchestrator({ prepareTaskForNewAttempt: prepare });
      const abandoned = dispatcher.abandonStuckLeases();

      expect(abandoned).toBe(1);
      const after = adapter.loadLaunchDispatchById(row.id);
      expect(after?.state).toBe('abandoned');
      expect(after?.lastError).toMatch(/Launch dispatch abandoned after 2 attempt/);
      expect(prepare).toHaveBeenCalledWith('wf-r/t1', 'launch-dispatch-abandoned');
      const events = adapter.getEvents('wf-r/t1');
      const failedEvent = events.find((event) => event.eventType === 'task.failed');
      expect(failedEvent).toBeDefined();
      expect(JSON.parse(failedEvent!.payload!)).toMatchObject({
        source: 'launch-dispatcher',
        dispatchId: row.id,
      });
    });

    it('CD.2: abandonStuckLeases releases execution-resource leases held by the abandoned task (Issue 14)', () => {
      seed();
      const row = adapter.enqueueLaunchDispatch({
        taskId: 'wf-r/t1',
        attemptId: 'attempt-ssh-abandon',
        workflowId: 'wf-r',
        generation: 0,
      });
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch
           SET state = 'leased', dispatch_owner = 'owner-x',
               fenced_until = ?, attempts_count = 2, last_error = 'ssh-selection stuck'
         WHERE id = ?`,
        [pastIso, row.id],
      );

      // Simulate the SSH pool taking a slot lease on behalf of this task
      // during executor selection — the lease normally survives the
      // launch and is released by TaskRunner.onComplete, but a launch
      // that never completes leaves it behind. We acquire two leases
      // here to confirm the dispatcher releases ALL of them, not just
      // the first.
      const acquired1 = adapter.claimExecutionResourceLease({
        resourceKey: 'ssh-pool/host-A',
        resourceType: 'ssh-pool-slot',
        holderId: 'launch-holder-1',
        taskId: 'wf-r/t1',
        poolId: 'ssh-pool',
        poolMemberId: 'host-A',
      });
      const acquired2 = adapter.claimExecutionResourceLease({
        resourceKey: 'worktree-pool/slot-7',
        resourceType: 'worktree-pool-slot',
        holderId: 'launch-holder-2',
        taskId: 'wf-r/t1',
        poolId: 'worktree-pool',
        poolMemberId: 'slot-7',
      });
      expect(acquired1).toBe(true);
      expect(acquired2).toBe(true);
      // Also seed an unrelated lease for a different task to make sure
      // the dispatcher does NOT release it.
      const unrelated = adapter.claimExecutionResourceLease({
        resourceKey: 'ssh-pool/host-B',
        resourceType: 'ssh-pool-slot',
        holderId: 'launch-holder-3',
        taskId: 'wf-other/tX',
        poolId: 'ssh-pool',
        poolMemberId: 'host-B',
      });
      expect(unrelated).toBe(true);

      const prepare = vi.fn();
      const { dispatcher } = dispatcherWithOrchestrator({ prepareTaskForNewAttempt: prepare });
      expect(dispatcher.abandonStuckLeases()).toBe(1);

      // The task's own leases must be gone.
      const remaining = adapter.listExecutionResourceLeasesByTask('wf-r/t1');
      expect(remaining).toHaveLength(0);
      // The unrelated lease must still be present.
      const stillThere = adapter.listExecutionResourceLeasesByTask('wf-other/tX');
      expect(stillThere).toHaveLength(1);

      // Both lease releases must have produced an audit event keyed
      // to the abandoned dispatch row.
      const events = adapter.getEvents('wf-r/t1');
      const releaseEvents = events.filter(
        (event) => event.eventType === 'task.launch_dispatch_lease_released',
      );
      expect(releaseEvents).toHaveLength(2);
      const keys = releaseEvents
        .map((event) => JSON.parse(event.payload!).resourceKey as string)
        .sort();
      expect(keys).toEqual(['ssh-pool/host-A', 'worktree-pool/slot-7']);
      for (const event of releaseEvents) {
        const payload = JSON.parse(event.payload!);
        expect(payload.dispatchId).toBe(row.id);
        expect(payload.reason).toBe('launch-dispatch-abandoned');
      }
      expect(prepare).toHaveBeenCalledWith('wf-r/t1', 'launch-dispatch-abandoned');
    });

    it('CD.2: abandonStuckLeases is a no-op for leases when no resource leases are held', () => {
      seed();
      const row = adapter.enqueueLaunchDispatch({
        taskId: 'wf-r/t1',
        attemptId: 'attempt-no-lease',
        workflowId: 'wf-r',
        generation: 0,
      });
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch
           SET state = 'leased', fenced_until = ?, attempts_count = 2,
               dispatch_owner = 'owner-x'
         WHERE id = ?`,
        [pastIso, row.id],
      );
      const prepare = vi.fn();
      const { dispatcher } = dispatcherWithOrchestrator({ prepareTaskForNewAttempt: prepare });
      expect(dispatcher.abandonStuckLeases()).toBe(1);
      const events = adapter.getEvents('wf-r/t1');
      expect(
        events.filter((event) => event.eventType === 'task.launch_dispatch_lease_released'),
      ).toHaveLength(0);
    });

    it('abandonStuckLeases ignores rows still within their fence or below max attempts', () => {
      seed();
      const futureRow = adapter.enqueueLaunchDispatch({
        taskId: 'wf-r/t1',
        attemptId: 'attempt-future',
        workflowId: 'wf-r',
        generation: 0,
      });
      const futureIso = new Date(Date.now() + 60_000).toISOString();
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch
           SET state = 'leased', fenced_until = ?, attempts_count = 5
         WHERE id = ?`,
        [futureIso, futureRow.id],
      );

      const underAttemptRow = adapter.enqueueLaunchDispatch({
        taskId: 'wf-r/t1',
        attemptId: 'attempt-under',
        workflowId: 'wf-r',
        generation: 0,
      });
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch
           SET state = 'leased', fenced_until = ?, attempts_count = 1
         WHERE id = ?`,
        [pastIso, underAttemptRow.id],
      );

      const prepare = vi.fn();
      const { dispatcher } = dispatcherWithOrchestrator({ prepareTaskForNewAttempt: prepare });
      expect(dispatcher.abandonStuckLeases()).toBe(0);
      expect(prepare).not.toHaveBeenCalled();
    });

    it('poll() runs reapers before dispatching new work', () => {
      seed();
      const row = adapter.enqueueLaunchDispatch({
        taskId: 'wf-r/t1',
        attemptId: 'attempt-poll',
        workflowId: 'wf-r',
        generation: 0,
      });
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch SET state = 'leased', dispatch_owner = 'owner-x', fenced_until = ? WHERE id = ?`,
        [pastIso, row.id],
      );

      const dispatcher = new LaunchDispatcher({
        persistence: adapter,
        ownerId: 'owner',
      });
      dispatcher.poll();
      expect(adapter.loadLaunchDispatchById(row.id)?.state).toBe('enqueued');
    });
  });

  describe('dispatch', () => {
    function seedWorkflowAndTask(
      taskId: string,
      workflowId = 'wf-a',
      execution: Record<string, unknown> = {},
    ) {
      adapter.saveWorkflow({ id: workflowId,
      name: workflowId, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), });
      const task = {
        id: taskId,
        description: taskId,
        status: 'pending' as const,
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId },
        execution,
        taskStateVersion: 1,
      };
      adapter.saveTask(workflowId, task);
      if (typeof execution.selectedAttemptId === 'string') {
        adapter.updateTask(taskId, {
          execution: {
            selectedAttemptId: execution.selectedAttemptId,
            generation: typeof execution.generation === 'number' ? execution.generation : 0,
          },
        });
      }
      return task;
    }

    it('leases an enqueued row and hands it to the TaskRunner', () => {
      const task = seedWorkflowAndTask('wf-a/t1', 'wf-a', {
        selectedAttemptId: 'attempt-active-1',
        generation: 0,
      });
      const enq = adapter.enqueueLaunchDispatch({
        taskId: task.id,
        attemptId: 'attempt-active-1',
        workflowId: 'wf-a',
        generation: 0,
      });

      const executeTask = vi.fn().mockResolvedValue(undefined);
      const getTask = vi.fn().mockReturnValue(task as any);

      const dispatcher = new LaunchDispatcher({
        persistence: adapter,
        ownerId: 'owner-a',
        orchestrator: {
          prepareTaskForNewAttempt: vi.fn(),
          getTask,
        },
        taskRunnerProvider: () => ({ executeTask }),
      });
      dispatcher.poll();

      expect(getTask).toHaveBeenCalledWith(task.id);
      expect(executeTask).toHaveBeenCalledTimes(1);
      const [taskArg, optsArg] = executeTask.mock.calls[0]!;
      expect(taskArg.id).toBe(task.id);
      expect(optsArg.dispatchId).toBe(enq.id);
      expect(optsArg.launchOutbox).toBe(dispatcher);

      // Row is leased on this poll; the runner will transition it via
      // completeDispatch/failDispatch (those are unit-tested elsewhere).
      const after = adapter.loadLaunchDispatchById(enq.id);
      expect(after?.state).toBe('leased');
      expect(after?.dispatchOwner).toBe('owner-a');
    });

    it('loops until maxLeasesPerPoll is reached', () => {
      for (let i = 0; i < 3; i += 1) {
        seedWorkflowAndTask(`wf-a/t${i}`, 'wf-a', {
          selectedAttemptId: `attempt-multi-${i}`,
          generation: 0,
        });
      }
      for (let i = 0; i < 3; i += 1) {
        adapter.enqueueLaunchDispatch({
          taskId: `wf-a/t${i}`,
          attemptId: `attempt-multi-${i}`,
          workflowId: 'wf-a',
          generation: 0,
        });
      }
      const executeTask = vi.fn().mockResolvedValue(undefined);
      const getTask = vi.fn((id: string) => ({
        id,
        description: id,
        status: 'pending',
        dependencies: [],
        createdAt: new Date(),
        config: { workflowId: 'wf-a' },
        execution: {
          selectedAttemptId: `attempt-multi-${id.at(-1)}`,
          generation: 0,
        },
        taskStateVersion: 1,
      } as any));

      const dispatcher = new LaunchDispatcher({
        persistence: adapter,
        ownerId: 'owner-a',
        orchestrator: {
          prepareTaskForNewAttempt: vi.fn(),
          getTask,
        },
        taskRunnerProvider: () => ({ executeTask }),
        maxLeasesPerPoll: 2,
      });
      dispatcher.poll();
      expect(executeTask).toHaveBeenCalledTimes(2);
    });

    it('hydrates the workflow before treating a dispatch row as missing', () => {
      const writer = new Orchestrator({
        persistence: adapter as any,
        messageBus: new InMemoryBus(),
        maxConcurrency: 1,
        deferRunningUntilLaunch: true,
      });
      writer.loadPlan({
        name: 'cold-cache-dispatch',
        tasks: [
          {
            id: 'alpha',
            description: 'alpha',
            command: 'echo alpha',
          },
        ],
      });
      const [started] = writer.startExecution();
      expect(started).toBeDefined();

      const cold = new Orchestrator({
        persistence: adapter as any,
        messageBus: new InMemoryBus(),
        maxConcurrency: 1,
        deferRunningUntilLaunch: true,
      });
      expect(cold.getTask(started!.id)).toBeUndefined();

      const executeTask = vi.fn().mockResolvedValue(undefined);
      const dispatcher = new LaunchDispatcher({
        persistence: adapter,
        ownerId: 'owner-a',
        orchestrator: {
          prepareTaskForNewAttempt: (taskId, reason) =>
            cold.prepareTaskForNewAttempt(taskId, reason),
          syncFromDb: (workflowId) => cold.syncFromDb(workflowId),
          getTask: (taskId) => cold.getTask(taskId),
        },
        taskRunnerProvider: () => ({ executeTask }),
      });

      dispatcher.poll();

      expect(cold.getTask(started!.id)).toBeDefined();
      expect(executeTask).toHaveBeenCalledTimes(1);
      expect(executeTask.mock.calls[0]?.[0].id).toBe(started!.id);
      expect(adapter.loadLaunchDispatchById(1)?.lastError).toBeUndefined();
    });

    it('abandons a dispatch row when the selected attempt changed after lease', () => {
      const task = seedWorkflowAndTask('wf-a/t-stale', 'wf-a', {
        selectedAttemptId: 'attempt-old',
        generation: 0,
      });
      const enq = adapter.enqueueLaunchDispatch({
        taskId: task.id,
        attemptId: 'attempt-old',
        workflowId: 'wf-a',
        generation: 0,
      });
      const currentTask = {
        ...task,
        execution: {
          ...task.execution,
          selectedAttemptId: 'attempt-current',
          generation: 1,
        },
      };
      const executeTask = vi.fn().mockResolvedValue(undefined);
      const dispatcher = new LaunchDispatcher({
        persistence: adapter,
        ownerId: 'owner-a',
        orchestrator: {
          prepareTaskForNewAttempt: vi.fn(),
          getTask: vi.fn().mockReturnValue(currentTask as any),
        },
        taskRunnerProvider: () => ({ executeTask }),
      });

      dispatcher.poll();

      expect(executeTask).not.toHaveBeenCalled();
      const after = adapter.loadLaunchDispatchById(enq.id);
      expect(after?.state).toBe('abandoned');
      expect(after?.lastError).toMatch(/selected attempt or generation changed/);
      const events = adapter.getEvents(task.id);
      expect(events.some((event) => event.eventType === 'task.launch_dispatch_invalidated')).toBe(true);
    });


    it('does not hand a dispatch row to TaskRunner when only the execution generation changed', () => {
      const task = seedWorkflowAndTask('wf-a/t-gen-only', 'wf-a', {
        selectedAttemptId: 'attempt-gen',
        generation: 0,
      });
      const enq = adapter.enqueueLaunchDispatch({
        taskId: task.id,
        attemptId: 'attempt-gen',
        workflowId: 'wf-a',
        generation: 0,
      });
      const currentTask = {
        ...task,
        execution: {
          ...task.execution,
          selectedAttemptId: 'attempt-gen',
          generation: 1,
        },
      };
      const executeTask = vi.fn().mockResolvedValue(undefined);
      const dispatcher = new LaunchDispatcher({
        persistence: adapter,
        ownerId: 'owner-a',
        orchestrator: {
          prepareTaskForNewAttempt: vi.fn(),
          getTask: vi.fn().mockReturnValue(currentTask as any),
        },
        taskRunnerProvider: () => ({ executeTask }),
      });

      dispatcher.poll();

      expect(executeTask).not.toHaveBeenCalled();
      const after = adapter.loadLaunchDispatchById(enq.id);
      expect(after?.state).toBe('abandoned');
      expect(after?.lastError).toMatch(/selected attempt or generation changed/);
      const invalidated = adapter
        .getEvents(task.id)
        .find((event) => event.eventType === 'task.launch_dispatch_invalidated');
      expect(invalidated).toBeDefined();
      expect(JSON.parse(invalidated!.payload!)).toMatchObject({
        dispatchId: enq.id,
        reason: 'selected_attempt_changed',
        dispatchAttemptId: 'attempt-gen',
        dispatchGeneration: 0,
        selectedAttemptId: 'attempt-gen',
        selectedGeneration: 1,
      });
    });

    it('does not hand a dispatch row to TaskRunner when only the selected attempt id changed', () => {
      const task = seedWorkflowAndTask('wf-a/t-attempt-only', 'wf-a', {
        selectedAttemptId: 'attempt-old',
        generation: 0,
      });
      const enq = adapter.enqueueLaunchDispatch({
        taskId: task.id,
        attemptId: 'attempt-old',
        workflowId: 'wf-a',
        generation: 0,
      });
      const currentTask = {
        ...task,
        execution: {
          ...task.execution,
          selectedAttemptId: 'attempt-new',
          generation: 0,
        },
      };
      const executeTask = vi.fn().mockResolvedValue(undefined);
      const dispatcher = new LaunchDispatcher({
        persistence: adapter,
        ownerId: 'owner-a',
        orchestrator: {
          prepareTaskForNewAttempt: vi.fn(),
          getTask: vi.fn().mockReturnValue(currentTask as any),
        },
        taskRunnerProvider: () => ({ executeTask }),
      });

      dispatcher.poll();

      expect(executeTask).not.toHaveBeenCalled();
      const after = adapter.loadLaunchDispatchById(enq.id);
      expect(after?.state).toBe('abandoned');
      expect(after?.lastError).toMatch(/selected attempt or generation changed/);
      const invalidated = adapter
        .getEvents(task.id)
        .find((event) => event.eventType === 'task.launch_dispatch_invalidated');
      expect(invalidated).toBeDefined();
      expect(JSON.parse(invalidated!.payload!)).toMatchObject({
        dispatchId: enq.id,
        reason: 'selected_attempt_changed',
        dispatchAttemptId: 'attempt-old',
        dispatchGeneration: 0,
        selectedAttemptId: 'attempt-new',
        selectedGeneration: 0,
      });
    });

    it('hands a dispatch row whose attempt and generation both match to the TaskRunner with no invalidation', () => {
      const task = seedWorkflowAndTask('wf-a/t-valid-lineage', 'wf-a', {
        selectedAttemptId: 'attempt-valid',
        generation: 3,
      });
      const enq = adapter.enqueueLaunchDispatch({
        taskId: task.id,
        attemptId: 'attempt-valid',
        workflowId: 'wf-a',
        generation: 3,
      });
      const currentTask = {
        ...task,
        execution: {
          ...task.execution,
          selectedAttemptId: 'attempt-valid',
          generation: 3,
        },
      };
      const executeTask = vi.fn().mockResolvedValue(undefined);
      const dispatcher = new LaunchDispatcher({
        persistence: adapter,
        ownerId: 'owner-a',
        orchestrator: {
          prepareTaskForNewAttempt: vi.fn(),
          getTask: vi.fn().mockReturnValue(currentTask as any),
        },
        taskRunnerProvider: () => ({ executeTask }),
      });

      dispatcher.poll();

      expect(executeTask).toHaveBeenCalledTimes(1);
      expect(executeTask.mock.calls[0]?.[1]?.dispatchId).toBe(enq.id);
      const after = adapter.loadLaunchDispatchById(enq.id);
      expect(after?.state).toBe('leased');
      expect(
        adapter
          .getEvents(task.id)
          .some((event) => event.eventType === 'task.launch_dispatch_invalidated'),
      ).toBe(false);
    });

    it('abandons the dispatch when readiness is blocked', () => {
      const task = seedWorkflowAndTask('wf-a/t-blocked', 'wf-a', {
        selectedAttemptId: 'attempt-blocked',
        generation: 0,
      });
      const enq = adapter.enqueueLaunchDispatch({
        taskId: task.id,
        attemptId: 'attempt-blocked',
        workflowId: 'wf-a',
        generation: 0,
      });
      expect(adapter.claimExecutionResourceLease({
        resourceKey: 'ssh:blocked',
        resourceType: 'ssh',
        holderId: 'holder-blocked',
        taskId: task.id,
      })).toBe(true);
      const executeTask = vi.fn();
      const dispatcher = new LaunchDispatcher({
        persistence: adapter,
        ownerId: 'owner-a',
        orchestrator: {
          prepareTaskForNewAttempt: vi.fn(),
          getTask: vi.fn().mockReturnValue(task as any),
          getTaskLaunchReadiness: vi.fn().mockReturnValue({
            ready: false,
            reason: 'waiting on wf-a/upstream (pending)',
            task,
          }),
        },
        taskRunnerProvider: () => ({ executeTask }),
      });

      dispatcher.poll();

      expect(executeTask).not.toHaveBeenCalled();
      const after = adapter.loadLaunchDispatchById(enq.id);
      expect(after?.state).toBe('abandoned');
      expect(after?.lastError).toMatch(/no longer launch-ready/);
      expect(adapter.listExecutionResourceLeasesByTask(task.id)).toEqual([]);
      const events = adapter.getEvents(task.id);
      const invalidated = events.find((event) => event.eventType === 'task.launch_dispatch_invalidated');
      expect(JSON.parse(invalidated!.payload!)).toMatchObject({
        dispatchId: enq.id,
        reason: 'not_launch_ready',
        readinessReason: 'waiting on wf-a/upstream (pending)',
      });
      const released = events.find((event) => event.eventType === 'task.launch_dispatch_lease_released');
      expect(JSON.parse(released!.payload!)).toMatchObject({
        dispatchId: enq.id,
        reason: 'not_launch_ready',
        resourceKey: 'ssh:blocked',
      });
    });

    it('abandons the dispatch when the orchestrator has no matching task', () => {
      seedWorkflowAndTask('wf-a/t-missing', 'wf-a', {
        selectedAttemptId: 'attempt-missing',
        generation: 0,
      });
      const enq = adapter.enqueueLaunchDispatch({
        taskId: 'wf-a/t-missing',
        attemptId: 'attempt-missing',
        workflowId: 'wf-a',
        generation: 0,
      });
      const executeTask = vi.fn();
      const dispatcher = new LaunchDispatcher({
        persistence: adapter,
        ownerId: 'owner-a',
        orchestrator: {
          prepareTaskForNewAttempt: vi.fn(),
          getTask: vi.fn().mockReturnValue(undefined),
        },
        taskRunnerProvider: () => ({ executeTask }),
      });
      dispatcher.poll();

      expect(executeTask).not.toHaveBeenCalled();
      const after = adapter.loadLaunchDispatchById(enq.id);
      expect(after?.state).toBe('abandoned');
      expect(after?.lastError).toMatch(/missing from orchestrator state/);
    });

    it('is a no-op when the queue is empty', () => {
      const executeTask = vi.fn();
      const dispatcher = new LaunchDispatcher({
        persistence: adapter,
        ownerId: 'owner-a',
        orchestrator: {
          prepareTaskForNewAttempt: vi.fn(),
          getTask: vi.fn(),
        },
        taskRunnerProvider: () => ({ executeTask }),
      });
      dispatcher.poll();
      expect(executeTask).not.toHaveBeenCalled();
    });

    it('catches runner promise rejections via failDispatch backstop', async () => {
      const task = seedWorkflowAndTask('wf-a/t-throw', 'wf-a', {
        selectedAttemptId: 'attempt-throw',
        generation: 0,
      });
      const enq = adapter.enqueueLaunchDispatch({
        taskId: task.id,
        attemptId: 'attempt-throw',
        workflowId: 'wf-a',
        generation: 0,
      });
      const executeTask = vi.fn().mockRejectedValue(new Error('runner exploded synchronously'));
      const dispatcher = new LaunchDispatcher({
        persistence: adapter,
        ownerId: 'owner-a',
        orchestrator: {
          prepareTaskForNewAttempt: vi.fn(),
          getTask: vi.fn().mockReturnValue(task as any),
        },
        taskRunnerProvider: () => ({ executeTask }),
      });
      dispatcher.poll();
      // Wait one microtask tick for the .catch backstop to run.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const after = adapter.loadLaunchDispatchById(enq.id);
      expect(after?.state).toBe('enqueued');
      expect(after?.lastError).toMatch(/runner exploded synchronously/);
    });
  });
});
