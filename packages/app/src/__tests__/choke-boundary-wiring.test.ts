import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricRegistry } from '@invoker/execution-engine';
import type { TaskLaunchDispatch } from '@invoker/data-store';

import { ChokeBoundaryMetrics } from '../choke-boundary-metrics.js';
import { registerReadOnlyIpcHandlers } from '../ipc-read-handlers.js';
import { LaunchDispatcher } from '../launch-dispatcher.js';
import { PersistedWorkflowMutationCoordinator } from '../persisted-workflow-mutation-coordinator.js';
import { getChokeBoundaryMetrics } from '../choke-boundary-metrics.js';
import { startStandaloneLaunchDispatcher } from '../headless-standalone-launch-dispatcher.js';
import { openDetachedViewerDatabase } from '../viewer-db-boundary.js';

class ThrowingMetricRegistry extends MetricRegistry {
  incrementCounter(): number {
    throw new Error('counter failed');
  }

  setGauge(): number {
    throw new Error('gauge failed');
  }

  observeHistogram(): void {
    throw new Error('histogram failed');
  }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeDispatch(id: number): TaskLaunchDispatch {
  return {
    id,
    workflowId: 'wf-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    generation: 0,
    state: 'leased',
    ownerId: 'owner',
    attemptsCount: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    leasedAt: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + 1_000).toISOString(),
    acknowledgedAt: null,
    completedAt: null,
    lastError: null,
    abandonReason: null,
  } as TaskLaunchDispatch;
}

describe('choke boundary wiring', () => {
  const adapters: Array<{ close: () => void }> = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.close();
  });

  it('records IPC requests on the shared request metric', async () => {
    const metrics = new ChokeBoundaryMetrics();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();

    registerReadOnlyIpcHandlers({
      ipcMain: {
        handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
          handlers.set(channel, handler);
        }),
      } as never,
      logger: makeLogger() as never,
      persistence: {} as never,
      getOrchestrator: () => ({}) as never,
      agentRegistry: {} as never,
      loadTaskByIdFromPersistence: () => undefined,
      resolveAgentSession: vi.fn(async () => null),
      recordStartupDuration: vi.fn(),
      getTaskDeltaStreamSequence: () => 1,
      chokeMetrics: metrics,
    });

    await expect(handlers.get('invoker:get-execution-pools')?.({})).resolves.toEqual(expect.any(Array));
    expect(metrics.registry.getValue('choke_boundary_requests_total', {
      boundary: 'ipc',
      channel: 'invoker:get-execution-pools',
      code: 'success',
    })).toBe(1);
  });

  it('records mutation accepts and heartbeat renewals as accounted WorkQueue completions', async () => {
    const metrics = new ChokeBoundaryMetrics();
    let nextIntentId = 0;
    const persistence = {
      enqueueWorkflowMutationIntent: vi.fn(() => {
        nextIntentId += 1;
        return nextIntentId;
      }),
      loadWorkflowMutationIntent: vi.fn((id: number) => ({
        id,
        workflowId: 'wf-1',
        channel: 'invoker:test',
        args: [],
        priority: 'normal',
        status: id === 2 ? 'running' : 'queued',
      })),
      listWorkflowMutationIntents: vi.fn(() => []),
      claimWorkflowMutationLease: vi.fn(() => false),
      loadTasks: vi.fn(() => []),
      renewWorkflowMutationLease: vi.fn(),
      completeWorkflowMutationIntent: vi.fn(),
    };
    const coordinator = new PersistedWorkflowMutationCoordinator(
      persistence as never,
      'owner',
      vi.fn(async () => 'ok'),
      { chokeMetrics: metrics },
    );

    coordinator.submit('wf-1', 'normal', 'invoker:test', [], { deferDrain: true });
    await (coordinator as unknown as {
      executeIntent: (workflowId: string, intent: unknown) => Promise<void>;
    }).executeIntent('wf-1', {
      id: 2,
      workflowId: 'wf-1',
      channel: 'invoker:test',
      args: [],
      priority: 'normal',
      status: 'running',
    });

    expect(metrics.getQueueSnapshot('mutation')).toMatchObject({ complete: 1, failed: 0, unaccounted: 0 });
    expect(metrics.getQueueSnapshot('heartbeat')).toMatchObject({ complete: 1, failed: 0, unaccounted: 0 });
  });

  it('records launch accepts, rejected accepts, and topup event-loop lag', () => {
    const metrics = new ChokeBoundaryMetrics();
    const persistence = {
      releaseExpiredExecutionResourceLeases: vi.fn(() => 0),
      listAbandonableLaunchDispatchLeases: vi.fn(() => []),
      reapExpiredLaunchDispatchLeases: vi.fn(() => []),
      claimLaunchDispatchAtomic: vi.fn(() => null),
      markLaunchDispatchAccepted: vi.fn((dispatchId: number) => dispatchId === 1),
      loadLaunchDispatchById: vi.fn((dispatchId: number) => makeDispatch(dispatchId)),
    };
    const dispatcher = new LaunchDispatcher({
      persistence: persistence as never,
      orchestrator: {
        prepareTaskForNewAttempt: vi.fn(),
        getQueueStatus: vi.fn(() => ({ runningCount: 0, maxConcurrency: 1 })),
        startExecution: vi.fn(() => []),
      },
      taskRunnerProvider: () => ({ executeTask: vi.fn(async () => {}) }),
      ownerId: 'owner',
      chokeMetrics: metrics,
    });

    dispatcher.poll();
    expect(dispatcher.acceptDispatch(1)).toBe(true);
    expect(dispatcher.acceptDispatch(2)).toBe(false);

    expect(metrics.getQueueSnapshot('launch')).toMatchObject({ complete: 1, failed: 1, unaccounted: 0 });
    expect(metrics.registry.getValue('choke_boundary_requests_total', {
      boundary: 'launch',
      code: 'rejected',
    })).toBe(1);
    expect(metrics.registry.getHistogram('choke_boundary_event_loop_lag_seconds', {
      boundary: 'launch.topup',
    })?.count).toBe(1);
  });

  it('records launch topup on the shared registry without per-call metrics wiring', () => {
    const metrics = getChokeBoundaryMetrics();
    const before = metrics.registry.getHistogram('choke_boundary_event_loop_lag_seconds', {
      boundary: 'launch.topup',
    })?.count ?? 0;
    const dispatcher = new LaunchDispatcher({
      persistence: {
        releaseExpiredExecutionResourceLeases: vi.fn(() => 0),
        listAbandonableLaunchDispatchLeases: vi.fn(() => []),
        reapExpiredLaunchDispatchLeases: vi.fn(() => []),
        claimLaunchDispatchAtomic: vi.fn(() => null),
      } as never,
      orchestrator: {
        prepareTaskForNewAttempt: vi.fn(),
        startExecution: vi.fn(() => []),
      },
      taskRunnerProvider: () => ({ executeTask: vi.fn(async () => {}) }),
      ownerId: 'owner',
    });

    dispatcher.poll();

    expect(metrics.registry.getHistogram('choke_boundary_event_loop_lag_seconds', {
      boundary: 'launch.topup',
    })?.count).toBeGreaterThan(before);
  });

  it('wires standalone launch dispatching to the shared registry', () => {
    const metrics = getChokeBoundaryMetrics();
    const before = metrics.registry.getHistogram('choke_boundary_event_loop_lag_seconds', {
      boundary: 'launch.topup',
    })?.count ?? 0;
    const logger = makeLogger();
    const controller = startStandaloneLaunchDispatcher({
      headlessDeps: {
        logger,
        persistence: {
          listAbandonableLaunchDispatchLeases: vi.fn(() => []),
          reapExpiredLaunchDispatchLeases: vi.fn(() => []),
          claimLaunchDispatchAtomic: vi.fn(() => null),
        },
        orchestrator: {
          startExecution: vi.fn(() => []),
        },
      } as never,
      ownerId: 'owner',
      createTaskExecutor: () => ({ executeTask: vi.fn(async () => {}) }) as never,
      setLatestTaskExecutor: vi.fn(),
    });

    controller.stop();

    expect(metrics.registry.getHistogram('choke_boundary_event_loop_lag_seconds', {
      boundary: 'launch.topup',
    })?.count).toBeGreaterThan(before);
  });

  it('wires SQLite callbacks into the shared registry', async () => {
    const metrics = getChokeBoundaryMetrics();
    const before = metrics.registry.getHistogram('choke_boundary_sqlite_transaction_seconds', {
      outcome: 'committed',
    })?.count ?? 0;
    const adapter = await openDetachedViewerDatabase();
    adapters.push(adapter);

    adapter.runInTransaction(() => undefined);

    expect((metrics.registry.getHistogram('choke_boundary_sqlite_transaction_seconds', {
      outcome: 'committed',
    })?.count ?? 0)).toBeGreaterThan(before);
  });

  it('does not let metric registry failures fail the operation', () => {
    const metrics = new ChokeBoundaryMetrics({ registry: new ThrowingMetricRegistry() });

    expect(() => metrics.recordRequest('ipc', 'success', { channel: 'x' })).not.toThrow();
    expect(() => metrics.recordQueueAccepted('mutation', 'intent:1')).not.toThrow();
    expect(() => metrics.recordEventLoopLag('launch.topup', 3)).not.toThrow();
    expect(() => metrics.recordSqliteTransaction({ outcome: 'committed', durationMs: 1 })).not.toThrow();
  });

  it('does not let metric error callbacks fail the operation', () => {
    const onMetricError = vi.fn(() => {
      throw new Error('callback failed');
    });
    const metrics = new ChokeBoundaryMetrics({
      registry: new ThrowingMetricRegistry(),
      onMetricError,
    });

    expect(() => metrics.recordRequest('ipc', 'success', { channel: 'x' })).not.toThrow();
    expect(() => metrics.recordQueueAccepted('mutation', 'intent:1')).not.toThrow();
    expect(() => metrics.recordEventLoopLag('launch.topup', 3)).not.toThrow();
    expect(onMetricError).toHaveBeenCalledWith('counter', expect.any(Error));
    expect(onMetricError).toHaveBeenCalledWith('gauge', expect.any(Error));
    expect(onMetricError).toHaveBeenCalledWith('histogram', expect.any(Error));
  });
});
