import type { InvokerClient } from '@invoker/slack-manager/src/invoker-client.js';

export interface InvokerWatcherDeps {
  client: Pick<InvokerClient, 'isHealthy'>;
  restart: () => Promise<void>;
  log: (level: string, message: string) => void;
  pollIntervalMs?: number;
  downThresholdMs?: number;
  restartCooldownMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface InvokerWatcher {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_DOWN_THRESHOLD_MS = 20 * 60_000;
const DEFAULT_RESTART_COOLDOWN_MS = 15 * 60_000;

export function createInvokerWatcher(deps: InvokerWatcherDeps): InvokerWatcher {
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const downThresholdMs = deps.downThresholdMs ?? DEFAULT_DOWN_THRESHOLD_MS;
  const restartCooldownMs = deps.restartCooldownMs ?? DEFAULT_RESTART_COOLDOWN_MS;
  const now = deps.now ?? (() => Date.now());

  let unhealthySince: number | null = null;
  let lastRestartAt: number | null = null;
  let interval: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    const healthy = await deps.client.isHealthy();
    const observedAt = now();

    if (healthy) {
      unhealthySince = null;
      return;
    }

    if (unhealthySince === null) {
      unhealthySince = observedAt;
      return;
    }

    const downDurationMs = observedAt - unhealthySince;
    const sinceLastRestartMs = lastRestartAt === null ? Number.POSITIVE_INFINITY : observedAt - lastRestartAt;
    if (downDurationMs < downThresholdMs || sinceLastRestartMs < restartCooldownMs) {
      return;
    }

    deps.log('error', `invoker unhealthy for ${downDurationMs}ms; restarting slack manager service`);
    lastRestartAt = observedAt;
    await deps.restart();
  };

  const runTick = (): void => {
    void tick().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      deps.log('error', `watcher tick failed: ${message}`);
    });
  };

  return {
    start(): void {
      if (interval !== null) return;
      runTick();
      interval = setInterval(runTick, pollIntervalMs);
      interval.unref?.();
    },
    stop(): void {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
    },
    tick,
  };
}
