import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import { Channels } from '@invoker/transport';

import {
  SPEND_CIRCUIT_BREAKER_WORKER_KIND,
  createSpendCircuitBreakerWorker,
  planSpendCircuitBreakerTrips,
} from '../workers/spend-circuit-breaker-worker.js';
import { recordCodexSpendGateTrip } from '../codex-spend-gate.js';
import { loadSpendCircuitBreakerState } from '../spend-circuit-breaker-state.js';
import { E2E_AUTOFIX_WORKER_KIND } from '../workers/e2e-autofix-worker.js';
import { PR_ADMIN_BYPASS_LAND_WORKER_KIND } from '../workers/pr-maintenance-workers.js';

const NOW = new Date('2026-09-04T03:00:00.000Z').getTime();
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spend-breaker-worker-test-'));
  tempDirs.push(dir);
  return dir;
}

function makeLogger() {
  return {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  } as any;
}

function writeSession(dir: string, fileName: string, opts: { cwd: string; totalTokens: number; timestamp: string }): void {
  const lines = [
    JSON.stringify({ timestamp: opts.timestamp, type: 'session_meta', payload: { cwd: opts.cwd } }),
    JSON.stringify({
      timestamp: opts.timestamp,
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { total_tokens: opts.totalTokens } } },
    }),
  ];
  writeFileSync(join(dir, fileName), lines.join('\n'));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('planSpendCircuitBreakerTrips', () => {
  it('trips a worker whose window spend exceeds its budget', () => {
    const decisions = planSpendCircuitBreakerTrips(
      new Map([[E2E_AUTOFIX_WORKER_KIND, 150_000]]),
      { [E2E_AUTOFIX_WORKER_KIND]: 100_000 },
      new Set(),
    );

    expect(decisions).toEqual([{ workerKind: E2E_AUTOFIX_WORKER_KIND, windowTokens: 150_000, tokenBudget: 100_000 }]);
  });

  it('does not trip a worker under budget', () => {
    const decisions = planSpendCircuitBreakerTrips(
      new Map([[E2E_AUTOFIX_WORKER_KIND, 50_000]]),
      { [E2E_AUTOFIX_WORKER_KIND]: 100_000 },
      new Set(),
    );

    expect(decisions).toEqual([]);
  });

  it('does not re-trip a worker that is already tripped', () => {
    const decisions = planSpendCircuitBreakerTrips(
      new Map([[E2E_AUTOFIX_WORKER_KIND, 999_999]]),
      { [E2E_AUTOFIX_WORKER_KIND]: 100_000 },
      new Set([E2E_AUTOFIX_WORKER_KIND]),
    );

    expect(decisions).toEqual([]);
  });
});

describe('createSpendCircuitBreakerWorker', () => {
  it('is a no-op when not enabled, even with real over-budget session data on disk', async () => {
    const sessionDir = makeTempDir();
    const statePath = join(makeTempDir(), 'state.json');
    writeSession(sessionDir, 'rollout-1.jsonl', {
      cwd: '/x/experiment-wf-1-1-fix-ci-g1.t1.a-abc',
      totalTokens: 999_999,
      timestamp: '2026-09-04T02:59:00.000Z',
    });
    const setWorkerDesiredState = vi.fn();

    const worker = createSpendCircuitBreakerWorker({
      logger: makeLogger(),
      store: {
        listWorkflows: () => [{ id: 'wf-1-1', description: 'invoker-ci-regression-watch: first-bad-sha=abc' }],
        setWorkerDesiredState,
      },
      enabled: false,
      tokenBudgetByWorkerKind: { [E2E_AUTOFIX_WORKER_KIND]: 100_000 },
      sessionDir,
      statePath,
      now: () => NOW,
      tickOnStart: false,
      intervalMs: 0,
    });

    await worker.tick('manual');

    expect(setWorkerDesiredState).not.toHaveBeenCalled();
  });

  it('disables the attributed worker and records a durable trip when over budget and enabled', async () => {
    const sessionDir = makeTempDir();
    const statePath = join(makeTempDir(), 'state.json');
    writeSession(sessionDir, 'rollout-1.jsonl', {
      cwd: '/x/experiment-wf-1-1-fix-ci-g1.t1.a-abc',
      totalTokens: 500_000,
      timestamp: '2026-09-04T02:59:00.000Z',
    });
    const setWorkerDesiredState = vi.fn();
    const logger = makeLogger();

    const worker = createSpendCircuitBreakerWorker({
      logger,
      store: {
        listWorkflows: () => [{ id: 'wf-1-1', description: 'invoker-ci-regression-watch: first-bad-sha=abc' }],
        setWorkerDesiredState,
      },
      enabled: true,
      windowMinutes: 60,
      tokenBudgetByWorkerKind: { [E2E_AUTOFIX_WORKER_KIND]: 100_000 },
      sessionDir,
      statePath,
      now: () => NOW,
      tickOnStart: false,
      intervalMs: 0,
    });

    await worker.tick('manual');

    expect(setWorkerDesiredState).toHaveBeenCalledExactlyOnceWith(E2E_AUTOFIX_WORKER_KIND, false);
    const state = loadSpendCircuitBreakerState(statePath);
    expect(state[E2E_AUTOFIX_WORKER_KIND]).toMatchObject({
      workerKind: E2E_AUTOFIX_WORKER_KIND,
      windowTokens: 500_000,
      tokenBudget: 100_000,
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('tripped'), expect.any(Object));
  });

  it('leaves an unattributed worker kind alone even when its budget is not configured', async () => {
    const sessionDir = makeTempDir();
    const statePath = join(makeTempDir(), 'state.json');
    writeSession(sessionDir, 'rollout-1.jsonl', {
      cwd: '/x/experiment-wf-1-1-fix-ci-g1.t1.a-abc',
      totalTokens: 999_999,
      timestamp: '2026-09-04T02:59:00.000Z',
    });
    const setWorkerDesiredState = vi.fn();

    const worker = createSpendCircuitBreakerWorker({
      logger: makeLogger(),
      store: {
        listWorkflows: () => [{ id: 'wf-1-1', description: 'invoker-ci-regression-watch: first-bad-sha=abc' }],
        setWorkerDesiredState,
      },
      enabled: true,
      tokenBudgetByWorkerKind: { [PR_ADMIN_BYPASS_LAND_WORKER_KIND]: 1 },
      sessionDir,
      statePath,
      now: () => NOW,
      tickOnStart: false,
      intervalMs: 0,
    });

    await worker.tick('manual');

    expect(setWorkerDesiredState).not.toHaveBeenCalled();
  });

  it('does not trip a worker whose in-budget spend is real but stays under the configured budget', async () => {
    const sessionDir = makeTempDir();
    const statePath = join(makeTempDir(), 'state.json');
    writeSession(sessionDir, 'rollout-1.jsonl', {
      cwd: '/x/experiment-wf-1-1-fix-ci-g1.t1.a-abc',
      totalTokens: 10_000,
      timestamp: '2026-09-04T02:59:00.000Z',
    });
    const setWorkerDesiredState = vi.fn();

    const worker = createSpendCircuitBreakerWorker({
      logger: makeLogger(),
      store: {
        listWorkflows: () => [{ id: 'wf-1-1', description: 'invoker-ci-regression-watch: first-bad-sha=abc' }],
        setWorkerDesiredState,
      },
      enabled: true,
      tokenBudgetByWorkerKind: { [E2E_AUTOFIX_WORKER_KIND]: 100_000 },
      sessionDir,
      statePath,
      now: () => NOW,
      tickOnStart: false,
      intervalMs: 0,
    });

    await worker.tick('manual');

    expect(setWorkerDesiredState).not.toHaveBeenCalled();
  });
});

describe('createSpendCircuitBreakerWorker Codex spend gate alert', () => {
  const TRIP = {
    trippedAt: '2026-09-13T16:35:24.179Z',
    dayKey: '2026-09-13',
    tokenBudget: 600_000_000,
    observedTokens: 610_323_524,
    tokensByHost: { owner: 559_935_118 },
  };

  function makeAlertStore() {
    const rows = new Map<string, WorkerActionRecord>();
    const upsertWorkerAction = vi.fn((write: WorkerActionWrite): WorkerActionRecord => {
      const record = {
        ...write,
        attemptCount: write.attemptCount ?? 0,
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: write.updatedAt ?? '2026-09-14T00:00:00.000Z',
      } as WorkerActionRecord;
      rows.set(`${write.workerKind}:${write.externalKey}`, record);
      return record;
    });
    return {
      rows,
      upsertWorkerAction,
      store: {
        listWorkflows: () => [],
        setWorkerDesiredState: vi.fn(),
        getWorkerAction: (workerKind: string, externalKey: string) => rows.get(`${workerKind}:${externalKey}`),
        upsertWorkerAction,
      },
    };
  }

  it('records one alert with the reset command while the gate is tripped', async () => {
    const gatePath = join(makeTempDir(), 'codex-spend-gate.json');
    recordCodexSpendGateTrip(gatePath, TRIP);
    const { rows, upsertWorkerAction, store } = makeAlertStore();
    const worker = createSpendCircuitBreakerWorker({
      logger: makeLogger(),
      store,
      codexDailyGate: { statePath: gatePath },
      statePath: join(makeTempDir(), 'state.json'),
      now: () => NOW,
      tickOnStart: false,
      intervalMs: 0,
    });

    await worker.tick('manual');
    await worker.tick('manual');

    expect(upsertWorkerAction).toHaveBeenCalledTimes(1);
    const [alert] = [...rows.values()];
    expect(alert).toMatchObject({
      workerKind: SPEND_CIRCUIT_BREAKER_WORKER_KIND,
      actionType: 'alert-send',
      status: 'completed',
    });
    expect(alert?.summary).toContain('Codex is shut off by the daily spend gate');
    expect(alert?.summary).toContain('invoker-cli spend-gate reset');
  });

  it('publishes one Slack alert with the reset command for a new trip', async () => {
    const gatePath = join(makeTempDir(), 'codex-spend-gate.json');
    recordCodexSpendGateTrip(gatePath, TRIP);
    const { store } = makeAlertStore();
    const publish = vi.fn();
    const worker = createSpendCircuitBreakerWorker({
      logger: makeLogger(),
      store,
      messageBus: { publish, subscribe: vi.fn(), request: vi.fn(), onRequest: vi.fn(), disconnect: vi.fn() },
      codexDailyGate: { statePath: gatePath },
      statePath: join(makeTempDir(), 'state.json'),
      now: () => NOW,
      tickOnStart: false,
      intervalMs: 0,
    });

    await worker.tick('manual');
    await worker.tick('manual');

    expect(publish).toHaveBeenCalledTimes(1);
    const [channel, event] = publish.mock.calls[0]!;
    expect(channel).toBe(Channels.SURFACE_EVENT);
    expect(event).toMatchObject({
      type: 'alert',
      alert: { severity: 'critical', source: SPEND_CIRCUIT_BREAKER_WORKER_KIND },
    });
    expect(event.alert.message).toContain('invoker-cli spend-gate reset');
  });

  it('records no alert while the gate is open', async () => {
    const { upsertWorkerAction, store } = makeAlertStore();
    const worker = createSpendCircuitBreakerWorker({
      logger: makeLogger(),
      store,
      codexDailyGate: { statePath: join(makeTempDir(), 'codex-spend-gate.json') },
      statePath: join(makeTempDir(), 'state.json'),
      now: () => NOW,
      tickOnStart: false,
      intervalMs: 0,
    });

    await worker.tick('manual');

    expect(upsertWorkerAction).not.toHaveBeenCalled();
  });
});
