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
});
