import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SQLiteAdapter } from '@invoker/data-store';
import { afterEach, describe, expect, it } from 'vitest';
import { PersistedWorkflowMutationCoordinator } from '../persisted-workflow-mutation-coordinator.js';

const ADD_COUNT = 1_000;
const WORKFLOW_COUNT = 50;
const ADD_P95_BUDGET_MS = 200;
const DRAIN_BUDGET_MS = 5_000;
const KNOWN_DISPATCH_ERROR = 'known mutation storm dispatch failure';

function percentile(values: number[], percent: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percent / 100) - 1)] ?? 0;
}

function makeLogger() {
  const calls: string[] = [];
  return {
    calls,
    logger: {
      debug: (message: string) => calls.push(`debug:${message}`),
      info: (message: string) => calls.push(`info:${message}`),
      warn: (message: string) => calls.push(`warn:${message}`),
      error: (message: string) => calls.push(`error:${message}`),
      child: () => makeLogger().logger,
    },
  };
}

async function waitForDrain(adapter: SQLiteAdapter, intentIds: number[]): Promise<boolean> {
  const deadline = Date.now() + DRAIN_BUDGET_MS;
  while (true) {
    const terminalIds = new Set(
      adapter.listWorkflowMutationIntents(undefined, ['completed', 'failed'])
        .map((intent) => intent.id),
    );
    if (intentIds.every((id) => terminalIds.has(id))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('submit latency under a workflow mutation queue storm (repro)', () => {
  const adapters: SQLiteAdapter[] = [];
  const tempDirs: string[] = [];
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const adapter of adapters.splice(0)) adapter.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('measures add latency, drain completion, and dispatch-error attribution', async () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-mutation-storm-home-'));
    const dbDir = mkdtempSync(join(tmpdir(), 'invoker-mutation-storm-db-'));
    tempDirs.push(home, dbDir);
    process.env.HOME = home;

    const adapter = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), { ownerCapability: true });
    adapters.push(adapter);
    const workflowIds = Array.from({ length: WORKFLOW_COUNT }, (_, index) => `wf-storm-${index}`);
    for (const workflowId of workflowIds) {
      adapter.saveWorkflow({
        id: workflowId,
        name: workflowId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const { calls, logger } = makeLogger();
    let failingIntentId: number | undefined;
    let releaseFailure: (() => void) | undefined;
    const failureStarted = new Promise<void>((resolve) => { releaseFailure = resolve; });
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'throwaway-storm-owner',
      async (channel, _args, context) => {
        if (channel === 'storm-failing-dispatch') {
          failingIntentId = context.intentId;
          await failureStarted;
          throw new Error(KNOWN_DISPATCH_ERROR);
        }
      },
      { logger },
    );

    const addLatencies: number[] = [];
    const intentIds: number[] = [];
    const add = (workflowId: string, channel: string, args: unknown[]): number => {
      const started = performance.now();
      const intentId = coordinator.submit(workflowId, 'normal', channel, args);
      addLatencies.push(performance.now() - started);
      intentIds.push(intentId);
      return intentId;
    };

    // Start the one known failure, then fence it while dispatch is pending.
    const firstFailureId = add(workflowIds[0]!, 'storm-failing-dispatch', []);
    while (failingIntentId === undefined) await new Promise((resolve) => setTimeout(resolve, 0));
    const fenceId = add(workflowIds[0]!, 'invoker:recreate-workflow', [workflowIds[0]!]);
    releaseFailure?.();
    while (adapter.loadWorkflowMutationIntent(fenceId)?.status !== 'completed') {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await Promise.all(workflowIds.flatMap((workflowId, workflowIndex) => {
      const count = ADD_COUNT / WORKFLOW_COUNT - (workflowIndex === 0 ? 2 : 0);
      return Array.from({ length: count }, (_, index) =>
        Promise.resolve().then(() => add(workflowId, 'storm-normal-dispatch', [index])));
    }));

    const drainStartedAt = performance.now();
    const drained = await waitForDrain(adapter, intentIds);
    const drainElapsedMs = performance.now() - drainStartedAt;
    const p95 = percentile(addLatencies, 95);
    const intentsById = new Map(
      adapter.listWorkflowMutationIntents().map((intent) => [intent.id, intent]),
    );
    const undrainedIds = intentIds.filter((id) => {
      const status = intentsById.get(id)?.status;
      return status !== 'completed' && status !== 'failed';
    });
    const failedDispatchRecorded = intentsById.get(firstFailureId)?.status === 'failed'
      && intentsById.get(firstFailureId)?.error?.includes(KNOWN_DISPATCH_ERROR);
    const dispatchErrorLogged = calls.some((call) => call.includes(KNOWN_DISPATCH_ERROR));
    const missingErrorIds = failedDispatchRecorded || dispatchErrorLogged ? [] : [firstFailureId];
    const hasDefect = p95 > ADD_P95_BUDGET_MS
      || undrainedIds.length > 0
      || missingErrorIds.length > 0;
    const measured = `p95=${p95.toFixed(1)}ms budget=${ADD_P95_BUDGET_MS}ms drain=${drainElapsedMs.toFixed(1)}ms drainBudget=${DRAIN_BUDGET_MS}ms drained=${drained} undrainedIds=${undrainedIds.join(',') || 'none'} missingDispatchErrorIds=${missingErrorIds.join(',') || 'none'}`;

    if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
      expect(hasDefect, measured).toBe(true);
      return;
    }

    expect(p95, measured).toBeLessThan(ADD_P95_BUDGET_MS);
    expect(drained, measured).toBe(true);
    expect(undrainedIds, measured).toEqual([]);
    expect(missingErrorIds, measured).toEqual([]);
  }, 122_000);
});
