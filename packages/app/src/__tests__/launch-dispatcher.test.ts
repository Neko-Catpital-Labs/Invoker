import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import type { Logger } from '@invoker/contracts';
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
      mode: 'observe',
    })).not.toThrow();
  });

  it('observer mode logs state counts and does not mutate rows', () => {
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
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
    const enqueued = adapter.enqueueLaunchDispatch({
      taskId: 'wf-1/t1',
      attemptId: 'attempt-1',
      workflowId: 'wf-1',
      generation: 0,
    });

    const logger = makeLogger();
    const dispatcher = new LaunchDispatcher({
      persistence: adapter,
      ownerId: 'owner-test',
      logger,
      mode: 'observe',
    });

    dispatcher.poll();

    const observed = logger.records.find((entry) => entry.msg.includes('observed'));
    expect(observed).toBeDefined();
    expect(observed?.fields?.total).toBe(1);
    const counts = observed?.fields?.counts as Record<string, number> | undefined;
    expect(counts?.enqueued).toBe(1);
    expect(counts?.leased).toBe(0);
    expect(counts?.acknowledged).toBe(0);

    const afterPoll = adapter.loadLaunchDispatchById(enqueued.id);
    expect(afterPoll).toMatchObject({ state: 'enqueued' });
  });

  it('active mode throws a CB.5 placeholder error', () => {
    const fakePersistence = {
      listLaunchDispatchesByState: vi.fn(),
    };
    const dispatcher = new LaunchDispatcher({
      persistence: fakePersistence as unknown as SQLiteAdapter,
      ownerId: 'owner-test',
      mode: 'active',
    });
    expect(() => dispatcher.poll()).toThrow(/CB\.5 not implemented/);
    expect(fakePersistence.listLaunchDispatchesByState).not.toHaveBeenCalled();
  });

  it('observer mode reports zero counts when the outbox is empty', () => {
    const logger = makeLogger();
    const dispatcher = new LaunchDispatcher({
      persistence: adapter,
      ownerId: 'owner-test',
      logger,
      mode: 'observe',
    });

    dispatcher.poll();

    const observed = logger.records.find((entry) => entry.msg.includes('observed'));
    expect(observed?.fields?.total).toBe(0);
  });

  describe('ack / complete / fail transitions', () => {
    function seedWorkflowAndTask(): void {
      adapter.saveWorkflow({
        id: 'wf-1',
        name: 'wf-1',
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
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
    }

    function makeDispatcher(logger = makeLogger()) {
      return {
        logger,
        dispatcher: new LaunchDispatcher({
          persistence: adapter,
          ownerId: 'owner-test',
          logger,
          mode: 'observe',
        }),
      };
    }

    it('ack moves a leased row to acknowledged and logs the transition', () => {
      seedWorkflowAndTask();
      const enqueued = adapter.enqueueLaunchDispatch({
        taskId: 'wf-1/t1',
        attemptId: 'attempt-ack',
        workflowId: 'wf-1',
        generation: 0,
      });
      const leased = adapter.claimLaunchDispatchAtomic({
        ownerId: 'owner-test',
        maxConcurrency: 4,
      });
      expect(leased?.id).toBe(enqueued.id);

      const { dispatcher, logger } = makeDispatcher();
      expect(dispatcher.ackDispatch(enqueued.id, 'runner-1')).toBe(true);

      const after = adapter.loadLaunchDispatchById(enqueued.id);
      expect(after?.state).toBe('acknowledged');
      expect(after?.dispatchOwner).toBe('runner-1');

      const ackLog = logger.records.find((entry) => entry.msg.includes('ack'));
      expect(ackLog?.fields?.accepted).toBe(true);
      expect(ackLog?.fields?.dispatchId).toBe(enqueued.id);
    });

    it('ack returns false when the row is no longer leased', () => {
      seedWorkflowAndTask();
      const enqueued = adapter.enqueueLaunchDispatch({
        taskId: 'wf-1/t1',
        attemptId: 'attempt-ack-stale',
        workflowId: 'wf-1',
        generation: 0,
      });

      const { dispatcher } = makeDispatcher();
      expect(dispatcher.ackDispatch(enqueued.id, 'runner-1')).toBe(false);
    });

    it('complete moves an acknowledged row to completed', () => {
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

    it('fail re-enqueues a leased row with the error message and clears the owner', () => {
      seedWorkflowAndTask();
      const enqueued = adapter.enqueueLaunchDispatch({
        taskId: 'wf-1/t1',
        attemptId: 'attempt-fail',
        workflowId: 'wf-1',
        generation: 0,
      });
      adapter.claimLaunchDispatchAtomic({
        ownerId: 'owner-test',
        maxConcurrency: 4,
      });

      const { dispatcher } = makeDispatcher();
      expect(dispatcher.failDispatch(enqueued.id, new Error('boom'))).toBe(true);

      const after = adapter.loadLaunchDispatchById(enqueued.id);
      expect(after?.state).toBe('enqueued');
      expect(after?.lastError).toBe('boom');
      expect(after?.dispatchOwner).toBeUndefined();
      expect(after?.fencedUntil).toBeUndefined();
    });

    it('fail coerces a non-Error value to its string form', () => {
      seedWorkflowAndTask();
      const enqueued = adapter.enqueueLaunchDispatch({
        taskId: 'wf-1/t1',
        attemptId: 'attempt-fail-string',
        workflowId: 'wf-1',
        generation: 0,
      });
      adapter.claimLaunchDispatchAtomic({
        ownerId: 'owner-test',
        maxConcurrency: 4,
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
});
