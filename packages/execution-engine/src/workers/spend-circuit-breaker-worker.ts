import { hostname, networkInterfaces } from 'node:os';

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
import {
  DEFAULT_CODEX_DAILY_TOKEN_BUDGET,
  buildRemoteCodexTallyScript,
  codexSpendGateDayKey,
  defaultCodexSessionRoot,
  defaultCodexSpendGatePath,
  evaluateCodexDailySpend,
  loadCodexSpendGateTrip,
  parseRemoteCodexTally,
  recordCodexSpendGateTrip,
  tallyCodexTokensForDay,
} from '../codex-spend-gate.js';
import { buildSshConnectionArgs, type SshTargetConnection } from '../ssh-transport-options.js';
import { execRemoteCapture } from '../ssh-git-exec.js';

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

export interface CodexSpendGateRemoteTarget {
  readonly name: string;
  readonly connection: SshTargetConnection;
  readonly sessionRoot?: string;
}

export interface CodexDailySpendGateConfig {
  enabled?: boolean;
  dailyTokenBudget?: number;
  localHostName?: string;
  localSessionRoot?: string;
  localAddresses?: ReadonlySet<string>;
  remoteTargets?: ReadonlyArray<CodexSpendGateRemoteTarget>;
  statePath?: string;
  tallyRemote?: (target: CodexSpendGateRemoteTarget, nowMs: number) => Promise<number>;
  tallyLocal?: (sessionRoot: string, nowMs: number) => number;
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
  codexDailyGate?: CodexDailySpendGateConfig;
  intervalMs?: number;
  tickOnStart?: boolean;
  now?: () => number;
  onTick?: WorkerTick;
}

export interface CodexDailySpendGateTickResult {
  readonly evaluated: boolean;
  readonly alreadyTripped: boolean;
  readonly tokensByHost: ReadonlyMap<string, number>;
  readonly totalTokens: number;
  readonly tokenBudget: number;
  readonly tripped: boolean;
  readonly failedHosts: ReadonlyArray<{ host: string; reason: string }>;
}

function ownAddresses(): ReadonlySet<string> {
  const addresses = new Set([hostname().toLowerCase()]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(entry.address.toLowerCase());
  }
  return addresses;
}

function defaultTallyRemote(target: CodexSpendGateRemoteTarget, nowMs: number): Promise<number> {
  const sessionRoot = target.sessionRoot ?? '~/.codex/sessions';
  return execRemoteCapture({
    sshArgs: buildSshConnectionArgs(target.connection, { batchMode: true }),
    script: buildRemoteCodexTallyScript(sessionRoot, nowMs),
    phase: `codex-spend-gate:${target.name}`,
  }).then(parseRemoteCodexTally);
}

export async function runCodexDailySpendGateTick(
  config: CodexDailySpendGateConfig,
  logger: Logger,
  nowMs: number,
): Promise<CodexDailySpendGateTickResult> {
  const tokenBudget = config.dailyTokenBudget ?? DEFAULT_CODEX_DAILY_TOKEN_BUDGET;
  const statePath = config.statePath ?? defaultCodexSpendGatePath();
  const empty = new Map<string, number>();

  if (config.enabled !== true || tokenBudget <= 0) {
    return {
      evaluated: false,
      alreadyTripped: false,
      tokensByHost: empty,
      totalTokens: 0,
      tokenBudget,
      tripped: false,
      failedHosts: [],
    };
  }

  if (loadCodexSpendGateTrip(statePath) !== undefined) {
    return {
      evaluated: false,
      alreadyTripped: true,
      tokensByHost: empty,
      totalTokens: 0,
      tokenBudget,
      tripped: false,
      failedHosts: [],
    };
  }

  const tokensByHost = new Map<string, number>();
  const failedHosts: Array<{ host: string; reason: string }> = [];

  const localName = config.localHostName ?? 'owner';
  const tallyLocal = config.tallyLocal ?? tallyCodexTokensForDay;
  try {
    tokensByHost.set(localName, tallyLocal(config.localSessionRoot ?? defaultCodexSessionRoot(), nowMs));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failedHosts.push({ host: localName, reason });
    logger.error(`[codex-spend-gate] local tally failed on ${localName}: ${reason}`, {
      module: 'codex-spend-gate',
      host: localName,
      reason,
    });
  }

  const tallyRemote = config.tallyRemote ?? defaultTallyRemote;
  const localAddresses = config.localAddresses ?? ownAddresses();
  for (const target of config.remoteTargets ?? []) {
    if (localAddresses.has(target.connection.host.toLowerCase())) continue;
    try {
      tokensByHost.set(target.name, await tallyRemote(target, nowMs));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failedHosts.push({ host: target.name, reason });
      logger.error(`[codex-spend-gate] remote tally failed on ${target.name}: ${reason}`, {
        module: 'codex-spend-gate',
        host: target.name,
        reason,
      });
    }
  }

  const evaluation = evaluateCodexDailySpend(tokensByHost, tokenBudget);
  const dayKey = codexSpendGateDayKey(nowMs);

  if (!evaluation.exceeded) {
    logger.info(
      `[codex-spend-gate] ${dayKey}: ${evaluation.totalTokens} of ${tokenBudget} daily Codex tokens used across ${tokensByHost.size} host(s)`,
      {
        module: 'codex-spend-gate',
        dayKey,
        totalTokens: evaluation.totalTokens,
        tokenBudget,
        failedHosts: failedHosts.length,
      },
    );
    return {
      evaluated: true,
      alreadyTripped: false,
      tokensByHost,
      totalTokens: evaluation.totalTokens,
      tokenBudget,
      tripped: false,
      failedHosts,
    };
  }

  recordCodexSpendGateTrip(statePath, {
    trippedAt: new Date(nowMs).toISOString(),
    dayKey,
    tokenBudget,
    observedTokens: evaluation.totalTokens,
    tokensByHost: Object.fromEntries(tokensByHost),
  });

  logger.error(
    `[codex-spend-gate] TRIPPED ${dayKey}: ${evaluation.totalTokens} Codex tokens exceeds the ${tokenBudget} daily budget; every Codex request now fails until \`invoker-cli spend-gate reset\``,
    {
      module: 'codex-spend-gate',
      dayKey,
      totalTokens: evaluation.totalTokens,
      tokenBudget,
      statePath,
    },
  );

  return {
    evaluated: true,
    alreadyTripped: false,
    tokensByHost,
    totalTokens: evaluation.totalTokens,
    tokenBudget,
    tripped: true,
    failedHosts,
  };
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
  const codexDailyGate = options.codexDailyGate ?? {};
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

      await runCodexDailySpendGateTick(codexDailyGate, options.logger, now());
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
    note: 'When configured with per-worker token budgets, disables a worker whose attributable Codex-session spend exceeds its budget within a rolling window. Its codexDailyGate section separately shuts Codex off fleet-wide once one day of Codex tokens across the owner and every remote target exceeds the daily budget; that trip fails every Codex request until `invoker-cli spend-gate reset`.',
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
        codexDailyGate: config.codexDailyGate,
        intervalMs: config.intervalMs,
        tickOnStart: config.tickOnStart,
        now: config.now,
      });
    },
  });
  return registry;
}
