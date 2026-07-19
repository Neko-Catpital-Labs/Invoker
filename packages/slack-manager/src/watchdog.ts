/**
 * Watchdog — polls Invoker health and relaunches it when it's down.
 *
 * Every `intervalMs` it checks `isHealthy()` (IPC ping, HTTP `/api/health`
 * fallback). After `failuresBeforeRelaunch` consecutive failures it calls
 * `launch()`. Relaunch attempts are spaced by an exponential backoff
 * (`baseBackoffMs` → `maxBackoffMs`); after `maxAttempts` it posts an alert and
 * stops auto-restarting until Invoker is healthy again (e.g. via a manual
 * `restart`). This backoff is the load-bearing guard against restart storms.
 *
 * A single healthy ping after relaunch does not clear attempt state. Invoker
 * must stay healthy for `stableHealthyPolls` consecutive ticks before the
 * watchdog treats recovery as complete. Alerts are rate-limited so a flapping
 * host does not spam the Slack lobby.
 */

import type { InvokerClient } from './invoker-client.js';
import { errMessage } from './util.js';

export interface WatchdogDeps {
  client: Pick<InvokerClient, 'isHealthy' | 'launch'>;
  log: (level: string, message: string) => void;
  /** Posts an operator-visible alert (e.g. to the lobby) when auto-restart gives up. */
  alert: (message: string) => Promise<void> | void;
  intervalMs?: number;
  failuresBeforeRelaunch?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Consecutive healthy polls required before clearing relaunch/attempt state. */
  stableHealthyPolls?: number;
  /** Minimum time between lobby/operator alerts while still down. */
  alertCooldownMs?: number;
  now?: () => number;
}

export interface Watchdog {
  start(): void;
  stop(): void;
  /** Run one health/relaunch cycle. Exposed for tests. */
  tick(): Promise<void>;
}

export function createWatchdog(deps: WatchdogDeps): Watchdog {
  const intervalMs = deps.intervalMs ?? 15_000;
  const failuresBeforeRelaunch = deps.failuresBeforeRelaunch ?? 2;
  const maxAttempts = deps.maxAttempts ?? 5;
  const baseBackoffMs = deps.baseBackoffMs ?? 60_000;
  const maxBackoffMs = deps.maxBackoffMs ?? 300_000;
  const stableHealthyPolls = deps.stableHealthyPolls ?? 3;
  const alertCooldownMs = deps.alertCooldownMs ?? 30 * 60_000;
  const now = deps.now ?? (() => Date.now());

  let consecutiveFailures = 0;
  let consecutiveHealthy = 0;
  let attempts = 0;
  let backoffMs = baseBackoffMs;
  let nextAttemptAt = 0;
  let gaveUp = false;
  let lastAlertAt: number | null = null;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const reset = (): void => {
    consecutiveFailures = 0;
    consecutiveHealthy = 0;
    attempts = 0;
    backoffMs = baseBackoffMs;
    nextAttemptAt = 0;
    gaveUp = false;
  };

  const inRecovery = (): boolean =>
    consecutiveFailures > 0 || attempts > 0 || gaveUp;

  const canAlert = (): boolean =>
    lastAlertAt === null || now() - lastAlertAt >= alertCooldownMs;

  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const healthy = await deps.client.isHealthy();
      if (healthy) {
        consecutiveFailures = 0;
        nextAttemptAt = 0;
        if (!inRecovery()) {
          consecutiveHealthy = 0;
          return;
        }
        consecutiveHealthy++;
        if (consecutiveHealthy < stableHealthyPolls) {
          deps.log(
            'info',
            `Invoker appears healthy (${consecutiveHealthy}/${stableHealthyPolls}) — waiting to confirm recovery`,
          );
          return;
        }
        deps.log('info', 'Invoker is healthy again');
        reset();
        return;
      }

      consecutiveHealthy = 0;
      consecutiveFailures++;
      if (consecutiveFailures < failuresBeforeRelaunch) return;

      if (gaveUp) {
        if (canAlert()) {
          lastAlertAt = now();
          await deps.alert(
            `:rotating_light: Invoker is still down after ${maxAttempts} relaunch attempts. Reply \`@Invoker restart\` to retry.`,
          );
        }
        return;
      }

      if (now() < nextAttemptAt) return;

      attempts++;
      deps.log('warn', `Invoker is down — relaunch attempt ${attempts}/${maxAttempts}`);
      const ok = await deps.client.launch();
      if (ok) {
        // Launch claimed success, but keep attempt state until health is stable.
        consecutiveFailures = 0;
        consecutiveHealthy = 0;
        nextAttemptAt = 0;
        deps.log('info', 'watchdog relaunch succeeded — confirming stable health');
        return;
      }
      if (attempts >= maxAttempts) {
        gaveUp = true;
        if (canAlert()) {
          lastAlertAt = now();
          await deps.alert(
            `:rotating_light: Invoker is down and I could not bring it back after ${maxAttempts} attempts. Reply \`@Invoker restart\` to retry.`,
          );
        } else {
          deps.log('warn', 'Invoker still down after max relaunch attempts — alert suppressed by cooldown');
        }
        return;
      }
      nextAttemptAt = now() + backoffMs;
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    } catch (err) {
      deps.log('error', `watchdog tick failed: ${errMessage(err)}`);
    } finally {
      busy = false;
    }
  };

  return {
    tick,
    start() {
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
