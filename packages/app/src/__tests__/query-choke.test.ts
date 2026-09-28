import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';

import { ChokeBoundaryMetrics } from '../choke-boundary-metrics.js';
import { runHeadlessClientCommand } from '../headless-client.js';
import {
  answerOwnerReadQuery,
  type OwnerReadQueryHandlers,
} from '../owner-read-query.js';

function zeroQueues() {
  return {
    mutation: { name: 'choke-mutation', queued: 0, processing: 0, complete: 0, failed: 0, added: 0, deduped: 0, unaccounted: 0 },
    launch: { name: 'choke-launch', queued: 0, processing: 0, complete: 0, failed: 0, added: 0, deduped: 0, unaccounted: 0 },
    heartbeat: { name: 'choke-heartbeat', queued: 0, processing: 0, complete: 0, failed: 0, added: 0, deduped: 0, unaccounted: 0 },
  };
}

function makeHandlers(over: Partial<OwnerReadQueryHandlers> = {}): OwnerReadQueryHandlers {
  return {
    ownerModeLabel: 'gui',
    onActivity: vi.fn(),
    getUiPerfStats: vi.fn(() => ({})),
    resetUiPerfStats: vi.fn(),
    getChokeSnapshot: vi.fn(() => ({ queues: zeroQueues(), prometheusText: '' })),
    getQueueStatus: vi.fn(() => ({})),
    listWorkerActionHistory: vi.fn((request) => ({ workerKind: request.workerKind, actions: [], limit: request.limit ?? 20, offset: request.offset ?? 0, hasMore: false })),
    listWorkerDecisions: vi.fn((request) => ({ decision: request.decision, actions: [], limit: request.limit ?? 20, offset: request.offset ?? 0, hasMore: false })),
    getWorkerStatus: vi.fn(() => ({ generatedAt: 'now', workers: [] })),
    getWorkers: vi.fn(() => ({ generatedAt: 'workers-now', workers: [] })),
    getWorkflowStatus: vi.fn(() => ({})),
    getTasksSnapshot: vi.fn(() => ({ tasks: [], workflows: [] })),
    getActionGraphSnapshot: vi.fn(() => ({})),
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
    ...over,
  };
}

describe('query choke', () => {
  const savedDbDir = process.env.INVOKER_DB_DIR;
  let dbDir: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'query-choke-'));
    process.env.INVOKER_DB_DIR = dbDir;
  });

  afterEach(() => {
    if (savedDbDir === undefined) delete process.env.INVOKER_DB_DIR;
    else process.env.INVOKER_DB_DIR = savedDbDir;
    rmSync(dbDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('answers the structured owner query with queue snapshots and Prometheus text', () => {
    const metrics = new ChokeBoundaryMetrics({ nowMs: () => 0 });
    metrics.recordRequest('ipc', 'success', { channel: 'invoker:test' });
    metrics.recordQueueAccepted('mutation', 'intent:1');

    const handlers = makeHandlers({
      getChokeSnapshot: () => metrics.getSnapshot(),
    });

    const response = answerOwnerReadQuery({ kind: 'choke' }, handlers);

    expect(response).toMatchObject({
      ownerMode: 'gui',
      queues: {
        mutation: {
          name: 'choke-mutation',
          complete: 1,
          unaccounted: 0,
        },
      },
    });
    expect(String(response.prometheusText)).toContain('# TYPE choke_boundary_requests_total counter');
    expect(String(response.prometheusText)).toContain('choke_boundary_requests_total{boundary="ipc",channel="invoker:test",code="success"} 1');
  });

  it('delegates JSON output to the owner-only choke query kind', async () => {
    const bus = new LocalBus();
    const response = {
      ownerMode: 'gui',
      queues: zeroQueues(),
      prometheusText: '# TYPE choke_boundary_requests_total counter\n',
    };
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', async (payload) => {
      expect(payload).toEqual({ kind: 'choke' });
      return response;
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runElectronHeadless = vi.fn(async () => 23);

    const exitCode = await runHeadlessClientCommand(['query', 'choke', '--output', 'json'], {
      messageBus: bus,
      ensureStandaloneOwner: vi.fn(async () => {}),
      runElectronHeadless,
    });

    expect(exitCode).toBe(0);
    expect(runElectronHeadless).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(`${JSON.stringify(response)}\n`);
  });

  it('renders Prometheus text by default from the delegated owner response', async () => {
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', async () => ({
      ownerMode: 'gui',
      queues: zeroQueues(),
      prometheusText: '# TYPE workqueue_completeness gauge\nworkqueue_completeness{name="choke-mutation",state="complete"} 1\n',
    }));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const exitCode = await runHeadlessClientCommand(['query', 'choke'], {
      messageBus: bus,
      ensureStandaloneOwner: vi.fn(async () => {}),
      runElectronHeadless: vi.fn(async () => 23),
    });

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith('# TYPE workqueue_completeness gauge\nworkqueue_completeness{name="choke-mutation",state="complete"} 1\n');
  });

  it('rejects reset before owner delegation', async () => {
    const bus = new LocalBus();
    const queryHandler = vi.fn(async () => ({ queues: zeroQueues(), prometheusText: '' }));
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', queryHandler);

    await expect(
      runHeadlessClientCommand(['query', 'choke', '--reset'], {
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(async () => {}),
        runElectronHeadless: vi.fn(async () => 23),
      }),
    ).rejects.toThrow(/not a read-only query/);
    expect(queryHandler).not.toHaveBeenCalled();
  });
});
