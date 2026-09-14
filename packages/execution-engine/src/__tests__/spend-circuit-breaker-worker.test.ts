import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpendCircuitBreakerWorker, planSpendCircuitBreakerTrips } from '../workers/spend-circuit-breaker-worker.js';
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
