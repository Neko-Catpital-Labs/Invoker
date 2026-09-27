import { describe, expect, it, vi } from 'vitest';
import { LocalBus, type MessageBus } from '@invoker/transport';

import { ChokeBoundaryMetrics, type ChokeBoundarySnapshot } from '../choke-boundary-metrics.js';
import { runHeadlessClientCommand } from '../headless-client.js';
import { runReadOnlyHeadlessQueryToString, type HeadlessQueryDeps } from '../headless-query-list.js';
import { answerOwnerReadQuery, type OwnerReadQueryHandlers } from '../owner-read-query.js';

function makeChokeSnapshot(): ChokeBoundarySnapshot {
  const metrics = new ChokeBoundaryMetrics({ nowMs: () => Date.parse('2026-09-27T00:00:00.000Z') });
  metrics.recordRequest('ipc', 'success', { channel: 'invoker:test' });
  metrics.recordQueueAccepted('mutation', 'intent:1');
  metrics.recordQueueRejected('launch', 'dispatch:2');
  return metrics.getSnapshot();
}

function makeQueryDeps(snapshot: ChokeBoundarySnapshot): HeadlessQueryDeps {
  return {
    persistence: {} as HeadlessQueryDeps['persistence'],
    orchestrator: {} as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
    getChokeSnapshot: () => snapshot,
  };
}

function makeOwnerHandlers(snapshot: ChokeBoundarySnapshot): OwnerReadQueryHandlers {
  return {
    ownerModeLabel: 'gui',
    onActivity: vi.fn(),
    getUiPerfStats: vi.fn(() => ({})),
    resetUiPerfStats: vi.fn(),
    getChokeSnapshot: vi.fn(() => snapshot),
    getQueueStatus: vi.fn(() => ({})),
    listWorkerActionHistory: vi.fn((request) => ({ workerKind: request.workerKind, actions: [], limit: request.limit ?? 20, offset: request.offset ?? 0, hasMore: false })),
    listWorkerDecisions: vi.fn((request) => ({ decision: request.decision, actions: [], limit: request.limit ?? 20, offset: request.offset ?? 0, hasMore: false })),
    getWorkerStatus: vi.fn(() => ({ generatedAt: 'now', workers: [] })),
    getWorkers: vi.fn(() => ({ generatedAt: 'now', workers: [] })),
    getWorkflowStatus: vi.fn(() => ({})),
    getTasksSnapshot: vi.fn(() => ({ tasks: [], workflows: [] })),
    getActionGraphSnapshot: vi.fn(() => ({ nodes: [], edges: [] })),
    listWorkflows: vi.fn(() => []),
    loadWorkflowBundle: vi.fn(() => ({ workflow: null, tasks: [] })),
    getReviewGate: vi.fn(() => null),
    getPlanningChatSession: vi.fn(() => null),
    getEvents: vi.fn(() => []),
    getTaskById: vi.fn(() => null),
    getTaskOutput: vi.fn(() => ''),
    getOutputChunks: vi.fn(() => []),
    getOutputTail: vi.fn(() => null),
    replayOutput: vi.fn(() => []),
    getAllCompletedTasks: vi.fn(() => []),
    getHistoryTasks: vi.fn(() => []),
  };
}

describe('query choke', () => {
  it('renders choke JSON and Prometheus text from the live snapshot provider', async () => {
    const snapshot = makeChokeSnapshot();
    const deps = makeQueryDeps(snapshot);

    const json = await runReadOnlyHeadlessQueryToString(['query', 'choke', '--output', 'json'], deps);
    expect(JSON.parse(json)).toMatchObject({
      generatedAt: '2026-09-27T00:00:00.000Z',
      queues: {
        mutation: { complete: 1, failed: 0, unaccounted: 0 },
        launch: { complete: 0, failed: 1, unaccounted: 0 },
        heartbeat: { complete: 0, failed: 0, unaccounted: 0 },
      },
    });

    const prometheus = await runReadOnlyHeadlessQueryToString(['query', 'choke', '--output', 'prometheus'], deps);
    expect(prometheus).toContain('choke_boundary_requests_total');
    expect(prometheus).toContain('boundary="ipc"');
  });

  it('answers the structured owner-read choke kind', () => {
    const snapshot = makeChokeSnapshot();
    const handlers = makeOwnerHandlers(snapshot);

    expect(answerOwnerReadQuery({ kind: 'choke' }, handlers)).toEqual(snapshot);
    expect(handlers.getChokeSnapshot).toHaveBeenCalledTimes(1);
  });

  it('delegates query choke to the owner and prints Prometheus text', async () => {
    const snapshot = makeChokeSnapshot();
    const bus = new LocalBus();
    const queryHandler = vi.fn(async (payload: unknown) => {
      expect(payload).toEqual({ kind: 'choke' });
      return snapshot;
    });
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', queryHandler);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runElectronHeadless = vi.fn(async () => 0);
    try {
      const exitCode = await runHeadlessClientCommand(['query', 'choke', '--output', 'prometheus'], {
        messageBus: bus as MessageBus,
        ensureStandaloneOwner: vi.fn(async () => {}),
        runElectronHeadless,
      });

      expect(exitCode).toBe(0);
      expect(runElectronHeadless).not.toHaveBeenCalled();
      expect(queryHandler).toHaveBeenCalledTimes(1);
      expect(stdout).toHaveBeenCalledWith(snapshot.prometheusText);
    } finally {
      stdout.mockRestore();
    }
  });

  it('rejects query choke --reset before delegation', async () => {
    const bus = new LocalBus();
    const queryHandler = vi.fn(async () => makeChokeSnapshot());
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', queryHandler);

    await expect(
      runHeadlessClientCommand(['query', 'choke', '--reset'], {
        messageBus: bus as MessageBus,
        ensureStandaloneOwner: vi.fn(async () => {}),
        runElectronHeadless: vi.fn(async () => 0),
      }),
    ).rejects.toThrow(/not a read-only query/);
    expect(queryHandler).not.toHaveBeenCalled();
  });
});
