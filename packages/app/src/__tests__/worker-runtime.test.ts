import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRecoveryWorker,
  createWorkerRuntime,
  RECOVERY_WORKER_KIND,
  type WorkerTickContext,
} from '../worker-runtime.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('worker runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('identity', () => {
    it('uses the explicit instance id when provided', () => {
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        instanceId: 'fixed-1',
        logger,
        onTick: () => {},
        installSignalHandlers: false,
      });
      expect(runtime.identity).toEqual({ kind: 'recovery', instanceId: 'fixed-1' });
    });

    it('generates a unique, kind-scoped instance id when omitted', () => {
      const a = createWorkerRuntime({ kind: 'recovery', logger, onTick: () => {}, installSignalHandlers: false });
      const b = createWorkerRuntime({ kind: 'recovery', logger, onTick: () => {}, installSignalHandlers: false });
      expect(a.identity.kind).toBe('recovery');
      expect(a.identity.instanceId).toContain('recovery');
      expect(a.identity.instanceId).not.toBe(b.identity.instanceId);
    });

    it('passes identity, reason, and tick number into the tick context', async () => {
      const contexts: WorkerTickContext[] = [];
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        instanceId: 'ctx-1',
        logger,
        onTick: (ctx) => {
          contexts.push(ctx);
        },
        installSignalHandlers: false,
      });

      await runtime.tick();
      await runtime.tick();

      expect(contexts).toHaveLength(2);
      expect(contexts[0]).toMatchObject({
        identity: { kind: 'recovery', instanceId: 'ctx-1' },
        reason: 'manual',
        tickNumber: 1,
      });
      expect(contexts[1].tickNumber).toBe(2);
    });

    it('reports runtime ownership and last tick/wakeup without changing scheduling', async () => {
      const onTick = vi.fn().mockResolvedValue(undefined);
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        instanceId: 'status-1',
        logger,
        onTick,
        tickOnStart: false,
        installSignalHandlers: false,
      });

      expect(runtime.getStatus()).toMatchObject({
        identity: { kind: 'recovery', instanceId: 'status-1' },
        running: false,
        tickCount: 0,
        lastTickAt: null,
        lastWakeupAt: null,
      });

      runtime.start();
      runtime.wake();
      await Promise.resolve();
      await Promise.resolve();

      expect(onTick).toHaveBeenCalledTimes(1);
      expect(runtime.getStatus()).toMatchObject({
        running: true,
        tickCount: 1,
        lastTickReason: 'wake',
        lastWakeupReason: 'wake',
      });
      expect(runtime.getStatus().startedAt).toEqual(expect.any(String));
      expect(runtime.getStatus().lastTickAt).toEqual(expect.any(String));
      expect(runtime.getStatus().lastWakeupAt).toEqual(expect.any(String));

      await runtime.stop();
      expect(runtime.getStatus()).toMatchObject({
        running: false,
        stoppedAt: expect.any(String),
      });
    });
  });

  describe('poll', () => {
    it('ticks on the periodic interval after start', async () => {
      vi.useFakeTimers();
      const onTick = vi.fn().mockResolvedValue(undefined);
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        logger,
        onTick,
        intervalMs: 1000,
        tickOnStart: false,
        installSignalHandlers: false,
      });

      runtime.start();
      expect(onTick).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(onTick).toHaveBeenCalledTimes(1);
      expect(onTick.mock.calls[0][0].reason).toBe('poll');

      await vi.advanceTimersByTimeAsync(1000);
      expect(onTick).toHaveBeenCalledTimes(2);

      await runtime.stop();
    });

    it('runs a startup tick when tickOnStart is set', async () => {
      const onTick = vi.fn().mockResolvedValue(undefined);
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        logger,
        onTick,
        tickOnStart: true,
        installSignalHandlers: false,
      });

      runtime.start();
      await Promise.resolve();
      await Promise.resolve();

      expect(onTick).toHaveBeenCalledTimes(1);
      expect(onTick.mock.calls[0][0].reason).toBe('startup');
      await runtime.stop();
    });

    it('does not poll when no interval is configured', async () => {
      vi.useFakeTimers();
      const onTick = vi.fn().mockResolvedValue(undefined);
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        logger,
        onTick,
        tickOnStart: false,
        installSignalHandlers: false,
      });

      runtime.start();
      await vi.advanceTimersByTimeAsync(5000);
      expect(onTick).not.toHaveBeenCalled();
      await runtime.stop();
    });
  });

  describe('wakeup', () => {
    it('runs a tick immediately on wake, outside the poll cadence', async () => {
      const onTick = vi.fn().mockResolvedValue(undefined);
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        logger,
        onTick,
        intervalMs: 60_000,
        tickOnStart: false,
        installSignalHandlers: false,
      });

      runtime.start();
      runtime.wake();
      await Promise.resolve();
      await Promise.resolve();

      expect(onTick).toHaveBeenCalledTimes(1);
      expect(onTick.mock.calls[0][0].reason).toBe('wake');
      await runtime.stop();
    });
  });

  describe('coalesce', () => {
    it('never runs ticks concurrently', async () => {
      const first = deferred();
      const onTick = vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue(undefined);
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        logger,
        onTick,
        installSignalHandlers: false,
      });

      const tickA = runtime.tick();
      // Second request arrives while the first tick is still running.
      runtime.wake();
      await Promise.resolve();
      expect(onTick).toHaveBeenCalledTimes(1);

      first.resolve();
      await tickA;
      await Promise.resolve();
      // The in-flight request collapsed into exactly one follow-up tick.
      expect(onTick).toHaveBeenCalledTimes(2);
      await runtime.stop();
    });

    it('collapses a burst of wakes into a single follow-up tick', async () => {
      const first = deferred();
      const onTick = vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue(undefined);
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        logger,
        onTick,
        installSignalHandlers: false,
      });

      const running = runtime.tick();
      runtime.wake();
      runtime.wake();
      runtime.wake();
      await Promise.resolve();
      expect(onTick).toHaveBeenCalledTimes(1);

      first.resolve();
      await running;
      await Promise.resolve();
      expect(onTick).toHaveBeenCalledTimes(2);
      await runtime.stop();
    });
  });

  describe('resilience', () => {
    it('continues after a tick throws', async () => {
      const onTick = vi.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(undefined);
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        logger,
        onTick,
        installSignalHandlers: false,
      });

      await runtime.tick();
      await runtime.tick();

      expect(onTick).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith('[worker:recovery] tick failed', expect.any(Object));
      await runtime.stop();
    });
  });

  describe('shutdown', () => {
    it('clears the poll timer on stop', async () => {
      vi.useFakeTimers();
      const onTick = vi.fn().mockResolvedValue(undefined);
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        logger,
        onTick,
        intervalMs: 1000,
        tickOnStart: false,
        installSignalHandlers: false,
      });

      runtime.start();
      await runtime.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(onTick).not.toHaveBeenCalled();
    });

    it('ignores wake after stop', async () => {
      const onTick = vi.fn().mockResolvedValue(undefined);
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        logger,
        onTick,
        tickOnStart: false,
        installSignalHandlers: false,
      });

      runtime.start();
      await runtime.stop();
      runtime.wake();
      await Promise.resolve();
      expect(onTick).not.toHaveBeenCalled();
      expect(runtime.isRunning()).toBe(false);
    });

    it('awaits the in-flight tick before resolving stop', async () => {
      const inFlight = deferred();
      let settled = false;
      const onTick = vi.fn().mockReturnValueOnce(inFlight.promise);
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        logger,
        onTick,
        installSignalHandlers: false,
      });

      void runtime.tick();
      await Promise.resolve();
      const stopping = runtime.stop().then(() => {
        settled = true;
      });

      await Promise.resolve();
      expect(settled).toBe(false);

      inFlight.resolve();
      await stopping;
      expect(settled).toBe(true);
    });

    it('is idempotent', async () => {
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        logger,
        onTick: () => {},
        tickOnStart: false,
        installSignalHandlers: false,
      });
      runtime.start();
      await runtime.stop();
      await expect(runtime.stop()).resolves.toBeUndefined();
    });

    it('cannot restart after stop', async () => {
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        logger,
        onTick: () => {},
        tickOnStart: false,
        installSignalHandlers: false,
      });
      runtime.start();
      await runtime.stop();
      expect(() => runtime.start()).toThrow(/cannot start after stop/);
    });

    it('shuts down on SIGTERM and removes its signal handlers', async () => {
      const before = process.listenerCount('SIGTERM');
      const onTick = vi.fn().mockResolvedValue(undefined);
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        logger,
        onTick,
        tickOnStart: false,
        shutdownSignals: ['SIGTERM'],
      });

      runtime.start();
      expect(process.listenerCount('SIGTERM')).toBe(before + 1);

      process.emit('SIGTERM');
      // Let the async stop() triggered by the signal handler settle.
      await Promise.resolve();
      await Promise.resolve();

      expect(runtime.isRunning()).toBe(false);
      expect(process.listenerCount('SIGTERM')).toBe(before);
    });

    it('removes signal handlers on an explicit stop', async () => {
      const before = process.listenerCount('SIGINT');
      const runtime = createWorkerRuntime({
        kind: 'recovery',
        logger,
        onTick: () => {},
        tickOnStart: false,
        shutdownSignals: ['SIGINT'],
      });

      runtime.start();
      expect(process.listenerCount('SIGINT')).toBe(before + 1);
      await runtime.stop();
      expect(process.listenerCount('SIGINT')).toBe(before);
    });
  });

  describe('recovery worker', () => {
    it('exposes the recovery identity', () => {
      const runtime = createRecoveryWorker({ logger, instanceId: 'rec-1', installSignalHandlers: false });
      expect(runtime.identity).toEqual({ kind: RECOVERY_WORKER_KIND, instanceId: 'rec-1' });
      expect(runtime.getRecoveryStatus().runtime.identity).toEqual(runtime.identity);
    });

    it('is behavior-neutral: its default tick does nothing and does not throw', async () => {
      const runtime = createRecoveryWorker({ logger, instanceId: 'rec-2', installSignalHandlers: false });
      await expect(runtime.tick()).resolves.toBeUndefined();
      expect(logger.error).not.toHaveBeenCalled();
      await runtime.stop();
    });

    it('does not auto-run a tick on start', async () => {
      vi.useFakeTimers();
      const onTick = vi.fn();
      const runtime = createRecoveryWorker({
        logger,
        instanceId: 'rec-3',
        intervalMs: 1000,
        onTick,
        installSignalHandlers: false,
      });
      runtime.start();
      await Promise.resolve();
      // tickOnStart defaults to false for the recovery worker.
      expect(onTick).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(onTick).toHaveBeenCalledTimes(1);
      await runtime.stop();
    });
  });
});
