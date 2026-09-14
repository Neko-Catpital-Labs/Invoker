import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { PersistedWorkflowMutationCoordinator } from '../persisted-workflow-mutation-coordinator.js';

const INTENT_COUNT = 1_000;
const WORKFLOW_COUNT = 50;
const INTENTS_PER_WORKFLOW = INTENT_COUNT / WORKFLOW_COUNT;
const ADD_P95_BUDGET_MS = 200;
const DRAIN_BUDGET_MS = 5_000;
const TEST_TIMEOUT_MS = 122_000;
const KNOWN_DISPATCH_ERROR = 'known mutation storm dispatch failure';

type LogCall = {
  level: string;
  message: string;
  args: unknown[];
};

function percentile(values: number[], percent: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percent / 100) - 1);
  return sorted[index] ?? 0;
}

function makeLogger(): { calls: LogCall[]; logger: any } {
  const calls: LogCall[] = [];
  const logger = {
    debug: (message: string, ...args: unknown[]) => calls.push({ level: 'debug', message, args }),
    info: (message: string, ...args: unknown[]) => calls.push({ level: 'info', message, args }),
    warn: (message: string, ...args: unknown[]) => calls.push({ level: 'warn', message, args }),
    error: (message: string, ...args: unknown[]) => calls.push({ level: 'error', message, args }),
    child: () => logger,
  };
  return { calls, logger };
}

function formatIds(ids: number[]): string {
  return ids.length === 0 ? 'none' : ids.join(',');
}

function logCallIncludes(call: LogCall, needle: string): boolean {
  return JSON.stringify([call.message, ...call.args]).includes(needle);
}

function isTimingLog(call: LogCall): boolean {
  return call.message.startsWith('[workflow-mutation-timing]');
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
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
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  it('measures add latency, drain completion, and dispatch-error attribution', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'invoker-mutation-queue-storm-'));
    const homeDir = join(tempRoot, 'home');
    const dbDir = join(tempRoot, 'db');
    tempDirs.push(tempRoot);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('INVOKER_DB_DIR', dbDir);
    vi.stubEnv('INVOKER_REPO_CONFIG_PATH', join(homeDir, '.invoker', 'config.json'));

    const adapter = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), { ownerCapability: true });
    adapters.push(adapter);

    const now = new Date().toISOString();
    const workflowIds = Array.from({ length: WORKFLOW_COUNT }, (_, index) => `wf-storm-${index}`);
    for (const workflowId of workflowIds) {
      adapter.saveWorkflow({
        id: workflowId,
        name: workflowId,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      });
    }

    const { calls, logger } = makeLogger();
    let failingIntentId: number | undefined;
    let releaseFailure: (() => void) | undefined;
    const failureStarted = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'throwaway-mutation-storm-owner',
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
    const addIntent = (workflowId: string, channel: string, args: unknown[]): number => {
      const startedAt = performance.now();
      const intentId = coordinator.submit(workflowId, 'normal', channel, args);
      addLatencies.push(performance.now() - startedAt);
      intentIds.push(intentId);
      return intentId;
    };

    const firstWorkflowId = workflowIds[0]!;
    const knownFailureId = addIntent(firstWorkflowId, 'storm-failing-dispatch', []);
    const failureClaimed = await waitFor(() => failingIntentId === knownFailureId, DRAIN_BUDGET_MS);
    expect(failureClaimed, `known failing intent was not claimed: knownFailureId=${knownFailureId}`).toBe(true);

    const fenceId = addIntent(firstWorkflowId, 'invoker:recreate-workflow', [firstWorkflowId]);
    releaseFailure?.();

    await Promise.all(workflowIds.flatMap((workflowId, workflowIndex) => {
      const remainingForWorkflow = INTENTS_PER_WORKFLOW - (workflowIndex === 0 ? 2 : 0);
      return Array.from({ length: remainingForWorkflow }, (_, index) =>
        Promise.resolve().then(() => addIntent(workflowId, 'storm-normal-dispatch', [index])));
    }));

    expect(intentIds).toHaveLength(INTENT_COUNT);

    const drainStartedAt = performance.now();
    const drained = await waitFor(() => intentIds.every((id) => {
      const status = adapter.loadWorkflowMutationIntent(id)?.status;
      return status === 'completed' || status === 'failed';
    }), DRAIN_BUDGET_MS);
    const drainElapsedMs = performance.now() - drainStartedAt;

    const p95 = percentile(addLatencies, 95);
    const undrainedIds = intentIds.filter((id) => {
      const status = adapter.loadWorkflowMutationIntent(id)?.status;
      return status !== 'completed' && status !== 'failed';
    });
    const failedDispatchIntent = adapter.loadWorkflowMutationIntent(knownFailureId);
    const failedDispatchRecorded = failedDispatchIntent?.error?.includes(KNOWN_DISPATCH_ERROR) ?? false;
    const timingDispatchErrorLogged = calls.some((call) =>
      isTimingLog(call) && logCallIncludes(call, KNOWN_DISPATCH_ERROR) && logCallIncludes(call, String(knownFailureId)));
    const nonTimingDispatchErrorLogged = calls.some((call) =>
      !isTimingLog(call) && logCallIncludes(call, KNOWN_DISPATCH_ERROR) && logCallIncludes(call, String(knownFailureId)));
    const missingDispatchErrorIds = failedDispatchRecorded || nonTimingDispatchErrorLogged ? [] : [knownFailureId];
    const missingRecordedDispatchErrorIds = failedDispatchRecorded ? [] : [knownFailureId];
    const missingNonTimingDispatchLogIds = nonTimingDispatchErrorLogged ? [] : [knownFailureId];
    const measured = [
      `p95=${p95.toFixed(1)}ms`,
      `budget=${ADD_P95_BUDGET_MS}ms`,
      `drain=${drainElapsedMs.toFixed(1)}ms`,
      `drainBudget=${DRAIN_BUDGET_MS}ms`,
      `drained=${drained}`,
      `fenceId=${fenceId}`,
      `undrainedIds=${formatIds(undrainedIds)}`,
      `missingDispatchErrorIds=${formatIds(missingDispatchErrorIds)}`,
      `missingRecordedDispatchErrorIds=${formatIds(missingRecordedDispatchErrorIds)}`,
      `missingNonTimingDispatchLogIds=${formatIds(missingNonTimingDispatchLogIds)}`,
      `timingDispatchErrorLogged=${timingDispatchErrorLogged}`,
      `failedDispatchStatus=${failedDispatchIntent?.status ?? 'missing'}`,
      `failedDispatchError=${failedDispatchIntent?.error ?? 'none'}`,
    ].join(' ');

    if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
      expect(
        p95 > ADD_P95_BUDGET_MS || !drained || missingDispatchErrorIds.length > 0,
        `expected at least one defect: ${measured}`,
      ).toBe(true);
      return;
    }

    expect(p95, `add-call p95 exceeded budget: ${measured}`).toBeLessThan(ADD_P95_BUDGET_MS);
    expect(drained, `not every intent drained: ${measured}`).toBe(true);
    expect(undrainedIds, `some intents never drained: ${measured}`).toEqual([]);
    expect(missingDispatchErrorIds, `dispatch failure was dropped: ${measured}`).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
