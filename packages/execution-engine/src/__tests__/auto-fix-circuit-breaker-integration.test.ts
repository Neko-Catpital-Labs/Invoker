import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { TaskState } from '@invoker/workflow-core';

import { createAutoFixAttemptLedger } from '../auto-fix-attempt-ledger.js';
import { createAutoFixRecoveryTick } from '../auto-fix-recovery.js';
import {
  clearCircuitBreaker, loadCircuitBreakerState, isCircuitBreakerPaused, tripCircuitBreaker,
} from '../auto-fix-circuit-breaker.js';

const logger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn(),
};

function makeFailedTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/build',
    description: 'build',
    status: 'failed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm build', ...(config ?? {}) },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/build',
      error: 'AssertionError: expected 1 to be 2',
      ...(execution ?? {}),
    },
    taskStateVersion: 7,
    ...rest,
  } as TaskState;
}

function makeStore(tasks: TaskState[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    listWorkflows: () => [{ id: 'wf-1', repoUrl: 'https://github.com/example/repo.git' }],
    loadTasks: () => tasks,
    loadTask: (taskId: string) => byId.get(taskId),
    listWorkflowMutationIntents: () => [],
    logEvent: vi.fn(),
    getWorkerAction: vi.fn(() => undefined),
    upsertWorkerAction: vi.fn((action) => ({ ...action, attemptCount: 1 })),
  };
}

describe('auto-fix circuit breaker integration', () => {
  let dir: string;
  let circuitBreakerPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'invoker-autofix-breaker-'));
    circuitBreakerPath = join(dir, 'auto-fix-pause.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reproduces the bug: a usage-limit failure on one task does not stop an UNRELATED failed task from being dispatched the same tick', async () => {
    // Before this fix, FailureClassifier had no usage-limit category and
    // auto-fix-recovery had no circuit breaker: this task would consume its
    // own attempt budget on a certain-to-fail retry, and every OTHER failed
    // task in the system kept getting dispatched normally, fleet-wide,
    // until the shared provider quota was gone.
    const usageLimitTask = makeFailedTask({
      id: 'wf-1/usage-limited',
      execution: {
        generation: 2, selectedAttemptId: 'a1', branch: 'x',
        error: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage "
          + 'to purchase more credits or try again at Aug 20th, 2026 4:36 AM.',
      },
    });
    const unrelatedTask = makeFailedTask({ id: 'wf-1/unrelated' });
    const submitted: string[] = [];
    const submitter = { submit: vi.fn((_wf, _prio, _channel, args: unknown[]) => { submitted.push(args[0] as string); return 1; }) };
    const store = makeStore([usageLimitTask, unrelatedTask]);

    const tick = createAutoFixRecoveryTick({
      store, submitter, logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 3,
      circuitBreakerPath,
      circuitBreakerPauseMs: 60 * 60 * 1000,
    });

    await tick({} as any);

    expect(submitted).not.toContain('wf-1/usage-limited');
    // The point of the circuit breaker, not just per-task classification:
    // the sibling task must ALSO be blocked in this same tick.
    expect(submitted).not.toContain('wf-1/unrelated');

    const state = loadCircuitBreakerState(circuitBreakerPath);
    expect(state.reason).toBe('usage-limit');
    expect(isCircuitBreakerPaused(state, Date.now())).toBe(true);
  });

  it('an unrelated failed task dispatches normally once the pause window has elapsed', async () => {
    tripCircuitBreaker(circuitBreakerPath, {
      now: new Date(Date.now() - 2 * 60 * 60 * 1000),
      reason: 'usage-limit',
      pauseMs: 60 * 60 * 1000, // already expired
    });
    const unrelatedTask = makeFailedTask({ id: 'wf-1/unrelated' });
    const submitted: string[] = [];
    const submitter = { submit: vi.fn((_wf, _prio, _channel, args: unknown[]) => { submitted.push(args[0] as string); return 1; }) };
    const store = makeStore([unrelatedTask]);

    const tick = createAutoFixRecoveryTick({
      store, submitter, logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 3,
      circuitBreakerPath,
    });

    await tick({} as any);

    expect(submitted).toContain('wf-1/unrelated');
  });

  const USAGE_LIMIT_ERROR = "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, "
    + 'or try again at Sep 16th, 2026 6:14 AM.';
  const HOUR_MS = 60 * 60 * 1000;

  function runTick(tasks: TaskState[], submitted: string[]) {
    const submitter = { submit: vi.fn((_wf, _prio, _channel, args: unknown[]) => { submitted.push(args[0] as string); return 1; }) };
    return createAutoFixRecoveryTick({
      store: makeStore(tasks), submitter, logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 3,
      circuitBreakerPath,
      circuitBreakerPauseMs: 6 * HOUR_MS,
    })({} as any);
  }

  it('a usage-limit failure that ended before the last trip does not re-arm the expired pause', async () => {
    const tripAt = new Date(Date.now() - 7 * HOUR_MS);
    tripCircuitBreaker(circuitBreakerPath, { now: tripAt, reason: 'usage-limit', pauseMs: 6 * HOUR_MS });
    const staleUsageLimitTask = makeFailedTask({
      id: 'wf-1/usage-limited',
      execution: {
        generation: 2, selectedAttemptId: 'a1', branch: 'x',
        error: USAGE_LIMIT_ERROR,
        completedAt: new Date(tripAt.getTime() - 1000),
      },
    });
    const unrelatedTask = makeFailedTask({ id: 'wf-1/unrelated' });
    const submitted: string[] = [];

    await runTick([staleUsageLimitTask, unrelatedTask], submitted);

    const state = loadCircuitBreakerState(circuitBreakerPath);
    expect(state.triggeredAt).toBe(tripAt.toISOString());
    expect(isCircuitBreakerPaused(state, Date.now())).toBe(false);
    expect(submitted).not.toContain('wf-1/usage-limited');
    expect(submitted).toContain('wf-1/unrelated');
  });

  it('a usage-limit failure that ended before an operator clear does not re-arm the pause', async () => {
    const failedAt = new Date(Date.now() - 5 * HOUR_MS);
    tripCircuitBreaker(circuitBreakerPath, { now: new Date(failedAt.getTime() + 1000), reason: 'usage-limit', pauseMs: 6 * HOUR_MS });
    clearCircuitBreaker(circuitBreakerPath);
    const staleUsageLimitTask = makeFailedTask({
      id: 'wf-1/usage-limited',
      execution: {
        generation: 2, selectedAttemptId: 'a1', branch: 'x',
        error: USAGE_LIMIT_ERROR,
        completedAt: failedAt,
      },
    });
    const unrelatedTask = makeFailedTask({ id: 'wf-1/unrelated' });
    const submitted: string[] = [];

    await runTick([staleUsageLimitTask, unrelatedTask], submitted);

    expect(isCircuitBreakerPaused(loadCircuitBreakerState(circuitBreakerPath), Date.now())).toBe(false);
    expect(submitted).toContain('wf-1/unrelated');
  });

  it('a usage-limit failure that ended after the last trip still re-arms the pause', async () => {
    const tripAt = new Date(Date.now() - 7 * HOUR_MS);
    tripCircuitBreaker(circuitBreakerPath, { now: tripAt, reason: 'usage-limit', pauseMs: 6 * HOUR_MS });
    const freshUsageLimitTask = makeFailedTask({
      id: 'wf-1/usage-limited',
      execution: {
        generation: 2, selectedAttemptId: 'a1', branch: 'x',
        error: USAGE_LIMIT_ERROR,
        completedAt: new Date(Date.now() - 60 * 1000),
      },
    });
    const unrelatedTask = makeFailedTask({ id: 'wf-1/unrelated' });
    const submitted: string[] = [];

    await runTick([freshUsageLimitTask, unrelatedTask], submitted);

    const state = loadCircuitBreakerState(circuitBreakerPath);
    expect(state.triggeredAt).not.toBe(tripAt.toISOString());
    expect(isCircuitBreakerPaused(state, Date.now())).toBe(true);
    expect(submitted).not.toContain('wf-1/unrelated');
  });

  it('dispatches normally with no pause file at all', async () => {
    const unrelatedTask = makeFailedTask({ id: 'wf-1/unrelated' });
    const submitted: string[] = [];
    const submitter = { submit: vi.fn((_wf, _prio, _channel, args: unknown[]) => { submitted.push(args[0] as string); return 1; }) };
    const store = makeStore([unrelatedTask]);

    const tick = createAutoFixRecoveryTick({
      store, submitter, logger,
      attemptLedger: createAutoFixAttemptLedger(),
      defaultAutoFixRetries: 3,
      circuitBreakerPath,
    });

    await tick({} as any);

    expect(submitted).toContain('wf-1/unrelated');
  });
});
