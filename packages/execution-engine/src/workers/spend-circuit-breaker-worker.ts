import type { Logger } from '@invoker/contracts';

import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import {
  classifyWorkflowToWorkerKind,
  listCodexSessionFiles,
  summarizeWorkerSpend,
  type WorkflowLookup,
} from '../spend-attribution.js';
import {
  defaultSpendCircuitBreakerPath,
  loadSpendCircuitBreakerState,
  recordSpendCircuitBreakerTrip,
  type SpendCircuitBreakerTripRecord,
} from '../spend-circuit-breaker-state.js';

export const SPEND_CIRCUIT_BREAKER_WORKER_KIND = 'spend-circuit-breaker';

const DEFAULT_SPEND_CIRCUIT_BREAKER_INTERVAL_MS = 10 * 60_000;
const DEFAULT_WINDOW_MS = 60 * 60_000;

export interface SpendCircuitBreakerWorkflowRow {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
}

export interface SpendCircuitBreakerWorkerStore {
  listWorkflows(): ReadonlyArray<SpendCircuitBreakerWorkflowRow>;
  setWorkerDesiredState(workerKind: string, desiredEnabled: boolean): unknown;
}

export interface SpendCircuitBreakerTripDecision {
  readonly workerKind: string;
  readonly windowTokens: number;
  readonly tokenBudget: number;
}

export function planSpendCircuitBreakerTrips(
  tokensByWorkerKind: ReadonlyMap<string, number>,
  tokenBudgetByWorkerKind: Readonly<Record<string, number>>,
  alreadyTrippedWorkerKinds: ReadonlySet<string>,
): SpendCircuitBreakerTripDecision[] {
  const decisions: SpendCircuitBreakerTripDecision[] = [];
  for (const [workerKind, tokenBudget] of Object.entries(tokenBudgetByWorkerKind)) {
    if (alreadyTrippedWorkerKinds.has(workerKind)) continue;
    const windowTokens = tokensByWorkerKind.get(workerKind) ?? 0;
    if (windowTokens > tokenBudget) {
      decisions.push({ workerKind, windowTokens, tokenBudget });
    }
  }
  return decisions;
}

export interface SpendCircuitBreakerWorkerConfig {
  enabled?: boolean;
  windowMinutes?: number;
  tokenBudgetByWorkerKind?: Readonly<Record<string, number>>;
  sessionDir?: string;
  statePath?: string;
  intervalMs?: number;
  tickOnStart?: boolean;
  now?: () => number;
  onTick?: WorkerTick;
}

export interface SpendCircuitBreakerWorkerOptions extends SpendCircuitBreakerWorkerConfig {
  logger: Logger;
  store: SpendCircuitBreakerWorkerStore;
}

export function createSpendCircuitBreakerWorker(options: SpendCircuitBreakerWorkerOptions): WorkerRuntime {
  const enabled = options.enabled ?? false;
  const windowMs = (options.windowMinutes ?? 60) * 60_000;
  const tokenBudgetByWorkerKind = options.tokenBudgetByWorkerKind ?? {};
  const sessionDir = options.sessionDir ?? defaultCodexSessionDir();
  const statePath = options.statePath ?? defaultSpendCircuitBreakerPath();
  const now = options.now ?? (() => Date.now());

  return createWorkerRuntime({
    kind: SPEND_CIRCUIT_BREAKER_WORKER_KIND,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_SPEND_CIRCUIT_BREAKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    onTick: async (ctx) => {
      ctx.signal?.throwIfAborted();
      await options.onTick?.(ctx);
      ctx.signal?.throwIfAborted();

      if (!enabled || Object.keys(tokenBudgetByWorkerKind).length === 0) return;

      const workflows = options.store.listWorkflows();
      const workflowById = new Map(workflows.map((w) => [w.id, w]));
      const lookupWorkflow: WorkflowLookup = (workflowId) => workflowById.get(workflowId);

      const sessionFiles = listCodexSessionFiles(sessionDir);
      const nowMs = now();
      const spend = summarizeWorkerSpend(sessionFiles, lookupWorkflow, { nowMs, windowMs });

      const trippedState = loadSpendCircuitBreakerState(statePath);
      const decisions = planSpendCircuitBreakerTrips(
        spend.tokensByWorkerKind,
        tokenBudgetByWorkerKind,
        new Set(Object.keys(trippedState)),
      );

      for (const decision of decisions) {
        if (ctx.signal?.aborted) return;
        options.store.setWorkerDesiredState(decision.workerKind, false);

        const record: SpendCircuitBreakerTripRecord = {
          workerKind: decision.workerKind,
          trippedAt: new Date(nowMs).toISOString(),
          windowStartMs: spend.windowStartMs,
          nowMs,
          windowTokens: decision.windowTokens,
          tokenBudget: decision.tokenBudget,
        };
        recordSpendCircuitBreakerTrip(statePath, record);

        options.logger.info(
          `[spend-circuit-breaker] tripped ${decision.workerKind}: ${decision.windowTokens} tokens over the last ${windowMs / 60_000}m exceeds budget ${decision.tokenBudget}; worker disabled`,
          { module: 'spend-circuit-breaker', workerKind: decision.workerKind, windowTokens: decision.windowTokens, tokenBudget: decision.tokenBudget },
        );
      }
    },
  });
}

function defaultCodexSessionDir(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const home = process.env.HOME ?? '';
  return `${home}/.codex/sessions/${now.getUTCFullYear()}/${pad(now.getUTCMonth() + 1)}/${pad(now.getUTCDate())}`;
}

export function registerSpendCircuitBreakerWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: SPEND_CIRCUIT_BREAKER_WORKER_KIND,
    note: 'Off by default. When configured with per-worker token budgets, disables a worker whose attributable Codex-session spend exceeds its budget within a rolling window.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      const config = deps.spendCircuitBreaker ?? {};
      return createSpendCircuitBreakerWorker({
        logger: deps.logger,
        store: deps.store,
        enabled: config.enabled,
        windowMinutes: config.windowMinutes,
        tokenBudgetByWorkerKind: config.tokenBudgetByWorkerKind,
        sessionDir: config.sessionDir,
        statePath: config.statePath,
        intervalMs: config.intervalMs,
        tickOnStart: config.tickOnStart,
        now: config.now,
      });
    },
  });
  return registry;
}
