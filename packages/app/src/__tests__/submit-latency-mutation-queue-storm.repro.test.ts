import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Logger, WorkflowMutationFailedEvent } from '@invoker/contracts';
import { SQLiteAdapter } from '@invoker/data-store';
import { afterEach, describe, expect, it } from 'vitest';
import { PersistedWorkflowMutationCoordinator } from '../persisted-workflow-mutation-coordinator.js';

const INTENT_COUNT = 1_000;
const WORKFLOW_COUNT = 50;
const ADD_P95_BUDGET_MS = 200;
const DRAIN_BUDGET_MS = 5_000;
const TEST_TIMEOUT_MS = 122_000;
const KNOWN_DISPATCH_ERROR = 'known mutation storm dispatch failure';

type LogEntry = {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields?: Record<string, unknown>;
};

function percentile(values: number[], percentileRank: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((sorted.length * percentileRank) / 100) - 1);
  return sorted[index] ?? 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeLogger(): { entries: LogEntry[]; logger: Logger } {
  const entries: LogEntry[] = [];
  const logger: Logger = {
    debug: (message, fields) => entries.push({ level: 'debug', message, fields }),
    info: (message, fields) => entries.push({ level: 'info', message, fields }),
    warn: (message, fields) => entries.push({ level: 'warn', message, fields }),
    error: (message, fields) => entries.push({ level: 'error', message, fields }),
    child: () => logger,
  };
  return { entries, logger };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  intervalMs = 10,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (condition()) return true;
    await delay(intervalMs);
  }
  return condition();
}

function logEntryIncludes(entry: LogEntry, needle: string, intentId: number): boolean {
  const serialized = JSON.stringify({
    message: entry.message,
    fields: entry.fields ?? {},
  });
  return serialized.includes(needle) && serialized.includes(String(intentId));
}

describe('submit latency under a workflow mutation queue storm (repro)', () => {
  const adapters: SQLiteAdapter[] = [];
  const tempDirs: string[] = [];
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
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

    const { entries, logger } = makeLogger();
    const failedEvents: WorkflowMutationFailedEvent[] = [];
    let runningFailureIntentId: number | undefined;
    let releaseFailure: (() => void) | undefined;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const coordinator = new PersistedWorkflowMutationCoordinator(
      adapter,
      'throwaway-mutation-storm-owner',
      async (channel, _args, context) => {
        if (channel !== 'storm-failing-dispatch') {
          return undefined;
        }
        runningFailureIntentId = context.intentId;
        await failureGate;
        throw new Error(KNOWN_DISPATCH_ERROR);
      },
      {
        logger,
        onIntentFailed: (event) => failedEvents.push(event),
      },
    );

    const addLatenciesMs: number[] = [];
    const intentIds: number[] = [];
    const addIntent = (workflowId: string, channel: string, args: unknown[]): number => {
      const startedAt = performance.now();
      const intentId = coordinator.submit(workflowId, 'normal', channel, args);
      addLatenciesMs.push(performance.now() - startedAt);
      intentIds.push(intentId);
      return intentId;
    };

    const failingIntentId = addIntent(workflowIds[0]!, 'storm-failing-dispatch', []);
    const failureStarted = await waitFor(
      () => runningFailureIntentId === failingIntentId,
      DRAIN_BUDGET_MS,
    );
    expect(
      failureStarted,
      `p95=unmeasured budget=${ADD_P95_BUDGET_MS}ms failureIntentId=${failingIntentId} did not start before ${DRAIN_BUDGET_MS}ms`,
    ).toBe(true);

    addIntent(workflowIds[0]!, 'invoker:recreate-workflow', [workflowIds[0]!]);
    releaseFailure?.();

    const remainingAdds: Array<() => void> = [];
    for (const [workflowIndex, workflowId] of workflowIds.entries()) {
      const alreadyAdded = workflowIndex === 0 ? 2 : 0;
      for (let index = alreadyAdded; index < INTENT_COUNT / WORKFLOW_COUNT; index += 1) {
        remainingAdds.push(() => {
          addIntent(workflowId, 'storm-normal-dispatch', [index]);
        });
      }
    }
    await Promise.all(remainingAdds.map((add) => Promise.resolve().then(add)));
    expect(intentIds).toHaveLength(INTENT_COUNT);

    const drainStartedAt = performance.now();
    const drained = await waitFor(
      () => intentIds.every((intentId) => {
        const status = adapter.loadWorkflowMutationIntent(intentId)?.status;
        return status === 'completed' || status === 'failed';
      }),
      DRAIN_BUDGET_MS,
    );
    const drainElapsedMs = performance.now() - drainStartedAt;

    const p95 = percentile(addLatenciesMs, 95);
    const undrainedIds = intentIds.filter((intentId) => {
      const status = adapter.loadWorkflowMutationIntent(intentId)?.status;
      return status !== 'completed' && status !== 'failed';
    });
    const failedIntent = adapter.loadWorkflowMutationIntent(failingIntentId);
    const errorRecordedOnIntent = failedIntent?.error?.includes(KNOWN_DISPATCH_ERROR) ?? false;
    const errorRecordedInFailureEvent = failedEvents.some((event) =>
      event.intentId === failingIntentId && event.message.includes(KNOWN_DISPATCH_ERROR));
    const errorLoggedWithIntentId = entries.some((entry) =>
      (entry.level === 'warn' || entry.level === 'error')
      && logEntryIncludes(entry, KNOWN_DISPATCH_ERROR, failingIntentId));
    const missingDispatchErrorIds = errorRecordedOnIntent || errorRecordedInFailureEvent || errorLoggedWithIntentId
      ? []
      : [failingIntentId];
    const latencyDefectIds = p95 > ADD_P95_BUDGET_MS ? intentIds : [];
    const defectIds = [...new Set([
      ...latencyDefectIds,
      ...undrainedIds,
      ...missingDispatchErrorIds,
    ])];
    const measured = [
      `p95=${p95.toFixed(1)}ms`,
      `budget=${ADD_P95_BUDGET_MS}ms`,
      `drain=${drainElapsedMs.toFixed(1)}ms`,
      `drainBudget=${DRAIN_BUDGET_MS}ms`,
      `drained=${drained}`,
      `undrainedIds=${undrainedIds.join(',') || 'none'}`,
      `missingDispatchErrorIds=${missingDispatchErrorIds.join(',') || 'none'}`,
      `failingIntentId=${failingIntentId}`,
      `failedIntentError=${failedIntent?.error ?? 'none'}`,
    ].join(' ');

    if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
      expect(defectIds.length, measured).toBeGreaterThan(0);
      return;
    }

    expect(p95, measured).toBeLessThan(ADD_P95_BUDGET_MS);
    expect(drained, measured).toBe(true);
    expect(undrainedIds, measured).toEqual([]);
    expect(missingDispatchErrorIds, measured).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
