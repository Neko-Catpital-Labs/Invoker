import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Logger } from '@invoker/contracts';
import { SQLiteAdapter } from '@invoker/data-store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersistedWorkflowMutationCoordinator } from '../persisted-workflow-mutation-coordinator.js';

const INTENT_COUNT = 1_000;
const WORKFLOW_COUNT = 50;
const ADD_P95_BUDGET_MS = 200;
const DRAIN_BUDGET_MS = 5_000;
const KNOWN_DISPATCH_ERROR = 'known mutation storm dispatch failure';

type LogCall = {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  metadata: unknown;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

function percentile(values: number[], percent: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percent / 100) - 1);
  return sorted[index] ?? 0;
}

function makeLogger(): { calls: LogCall[]; logger: Logger } {
  const calls: LogCall[] = [];
  const record = (level: LogCall['level']) => (message: string, metadata?: unknown) => {
    calls.push({ level, message, metadata });
  };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  return { calls, logger };
}

async function waitUntil(condition: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  while (performance.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return condition();
}

describe('submit latency under a workflow mutation queue storm (repro)', () => {
  const adapters: SQLiteAdapter[] = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const adapter of adapters.splice(0)) adapter.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('measures add latency, drain completion, and dispatch-error attribution', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'invoker-mutation-storm-home-'));
    const tempDbDir = mkdtempSync(join(tmpdir(), 'invoker-mutation-storm-db-'));
    tempDirs.push(tempHome, tempDbDir);
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('INVOKER_DB_DIR', tempDbDir);

    const adapter = await SQLiteAdapter.create(join(tempDbDir, 'invoker.db'), { ownerCapability: true });
    adapters.push(adapter);
    const workflowIds = Array.from({ length: WORKFLOW_COUNT }, (_, index) => `wf-storm-${index}`);
    const now = new Date().toISOString();
    for (const workflowId of workflowIds) {
      adapter.saveWorkflow({ id: workflowId, name: workflowId, createdAt: now, updatedAt: now });
    }

    const { calls, logger } = makeLogger();
    const failureStarted = deferred();
    const releaseFailure = deferred();
    const failureThrown = deferred();
    let failingIntentId: number | undefined;
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'throwaway-mutation-storm-owner',
      async (channel, _args, context) => {
        if (channel !== 'storm-failing-dispatch') return;
        failingIntentId = context.intentId;
        failureStarted.resolve();
        await releaseFailure.promise;
        failureThrown.resolve();
        throw new Error(KNOWN_DISPATCH_ERROR);
      },
      { logger },
    );

    const addLatencies: number[] = [];
    const intentIds: number[] = [];
    const add = (workflowId: string, channel: string, args: unknown[]): number => {
      const startedAt = performance.now();
      const intentId = coordinator.submit(workflowId, 'normal', channel, args);
      addLatencies.push(performance.now() - startedAt);
      intentIds.push(intentId);
      return intentId;
    };

    await Promise.all(Array.from({ length: INTENT_COUNT }, (_, index) =>
      Promise.resolve().then(async () => {
        if (index === 0) {
          return add(workflowIds[0]!, 'storm-failing-dispatch', []);
        }
        if (index === 1) {
          await failureStarted.promise;
          const fenceId = add(workflowIds[0]!, 'invoker:recreate-workflow', [workflowIds[0]!]);
          releaseFailure.resolve();
          return fenceId;
        }
        const workflowId = workflowIds[index % WORKFLOW_COUNT]!;
        return add(workflowId, 'storm-normal-dispatch', [index]);
      })));

    const drainStartedAt = performance.now();
    await failureThrown.promise;
    const loadTerminalIds = (): Set<number> => new Set(
      adapter.listWorkflowMutationIntents(undefined, ['completed', 'failed']).map((intent) => intent.id),
    );
    const drained = await waitUntil(() => {
      const terminalIds = loadTerminalIds();
      return intentIds.every((intentId) => terminalIds.has(intentId));
    }, DRAIN_BUDGET_MS);
    const drainElapsedMs = performance.now() - drainStartedAt;
    const p95 = percentile(addLatencies, 95);
    const terminalIds = loadTerminalIds();
    const undrainedIds = intentIds.filter((intentId) => !terminalIds.has(intentId));

    if (failingIntentId === undefined) {
      throw new Error('Known failing dispatch did not start');
    }
    const failedIntent = adapter.loadWorkflowMutationIntent(failingIntentId);
    const failedDispatchRecorded = failedIntent?.status === 'failed'
      && failedIntent.error?.includes(KNOWN_DISPATCH_ERROR) === true;
    // Timing telemetry is not a dispatch-error report. Require the error-level
    // entry to carry both the rejected dispatch's message and its intent id.
    const dispatchErrorLogged = calls.some((call) => {
      if (call.level !== 'error') return false;
      const rendered = `${call.message} ${JSON.stringify(call.metadata)}`;
      return rendered.includes(KNOWN_DISPATCH_ERROR) && rendered.includes(String(failingIntentId));
    });
    const missingDispatchErrorIds = failedDispatchRecorded || dispatchErrorLogged ? [] : [failingIntentId];
    const measured = [
      `p95=${p95.toFixed(1)}ms`,
      `budget=${ADD_P95_BUDGET_MS}ms`,
      `drain=${drainElapsedMs.toFixed(1)}ms`,
      `drainBudget=${DRAIN_BUDGET_MS}ms`,
      `intentCount=${intentIds.length}`,
      `workflowCount=${workflowIds.length}`,
      `failingIntentId=${failingIntentId}`,
      `undrainedIds=${undrainedIds.join(',') || 'none'}`,
      `missingDispatchErrorIds=${missingDispatchErrorIds.join(',') || 'none'}`,
    ].join(' ');
    const defects = [
      ...(p95 >= ADD_P95_BUDGET_MS ? [`p95-over-budget:${p95.toFixed(1)}ms`] : []),
      ...undrainedIds.map((intentId) => `undrained:${intentId}`),
      ...missingDispatchErrorIds.map((intentId) => `missing-dispatch-error:${intentId}`),
    ];

    if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
      expect(defects, measured).not.toEqual([]);
      return;
    }

    expect(p95, measured).toBeLessThan(ADD_P95_BUDGET_MS);
    expect(drained, measured).toBe(true);
    expect(undrainedIds, measured).toEqual([]);
    expect(missingDispatchErrorIds, measured).toEqual([]);
  }, 122_000);
});
