import { describe, expect, it, vi } from 'vitest';
import { resolveGuiQueueStatusRead } from '../ipc/gui-mutation-handlers.js';

function makeQueueStatus(description: string) {
  return {
    maxConcurrency: 13,
    runningCount: 1,
    activeExecutionCount: 1,
    launchingCount: 0,
    running: [{ taskId: 'wf-1/t1', description }],
    queued: [],
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('resolveGuiQueueStatusRead', () => {
  it('uses the local owner cache without delegating in owner mode', async () => {
    const ownerQueue = makeQueueStatus('owner running task');
    const request = vi.fn();
    const getQueueStatus = vi.fn(() => ownerQueue);

    await expect(resolveGuiQueueStatusRead({
      ownerMode: true,
      messageBus: { request } as never,
      orchestrator: { getQueueStatus } as never,
      logger: makeLogger() as never,
      markDaemonOwnerUnavailable: vi.fn(),
    })).resolves.toEqual(ownerQueue);

    expect(request).not.toHaveBeenCalled();
    expect(getQueueStatus).toHaveBeenCalledWith({ refresh: false });
  });

  it('force-refreshes local owner reads when requested', async () => {
    const ownerQueue = makeQueueStatus('owner running task');
    const request = vi.fn();
    const getQueueStatus = vi.fn(() => ownerQueue);

    await expect(resolveGuiQueueStatusRead({
      ownerMode: true,
      messageBus: { request } as never,
      orchestrator: { getQueueStatus } as never,
      logger: makeLogger() as never,
      markDaemonOwnerUnavailable: vi.fn(),
      refresh: true,
    })).resolves.toEqual(ownerQueue);

    expect(request).not.toHaveBeenCalled();
    expect(getQueueStatus).toHaveBeenCalledWith({ refresh: true });
  });

  it('delegates viewer reads to the owner queue query', async () => {
    const delegatedQueue = makeQueueStatus('owner running task');
    const request = vi.fn(async () => delegatedQueue);
    const getQueueStatus = vi.fn();

    await expect(resolveGuiQueueStatusRead({
      ownerMode: false,
      messageBus: { request } as never,
      orchestrator: { getQueueStatus } as never,
      logger: makeLogger() as never,
      markDaemonOwnerUnavailable: vi.fn(),
    })).resolves.toEqual(delegatedQueue);

    expect(request).toHaveBeenCalledWith('headless.query', { kind: 'queue' });
    expect(getQueueStatus).not.toHaveBeenCalled();
  });

  it('refreshes the local read-only fallback only when no owner handler exists', async () => {
    const localQueue = makeQueueStatus('db-backed running task');
    const error = Object.assign(new Error('No request handler registered for channel: headless.query'), { code: 'NO_HANDLER' });
    const request = vi.fn(async () => {
      throw error;
    });
    const getQueueStatus = vi.fn(() => localQueue);
    const logger = makeLogger();
    const markDaemonOwnerUnavailable = vi.fn();

    await expect(resolveGuiQueueStatusRead({
      ownerMode: false,
      messageBus: { request } as never,
      orchestrator: { getQueueStatus } as never,
      logger: logger as never,
      markDaemonOwnerUnavailable,
    })).resolves.toEqual(localQueue);

    expect(markDaemonOwnerUnavailable).toHaveBeenCalledWith(error.message);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to local read-only snapshot'),
      { module: 'ipc' },
    );
    expect(getQueueStatus).toHaveBeenCalledWith({ refresh: true });
  });

  it('propagates owner timeouts instead of serving follower-local zeros', async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error('owner timed out'), { code: 'REQUEST_TIMEOUT' });
    });
    const getQueueStatus = vi.fn();

    await expect(resolveGuiQueueStatusRead({
      ownerMode: false,
      messageBus: { request } as never,
      orchestrator: { getQueueStatus } as never,
      logger: makeLogger() as never,
      markDaemonOwnerUnavailable: vi.fn(),
    })).rejects.toThrow(/owner timed out/);

    expect(getQueueStatus).not.toHaveBeenCalled();
  });
});
