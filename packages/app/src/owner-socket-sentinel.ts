/**
 * Owner socket sentinel — enforces "the DB writer-lock holder serves the IPC
 * socket". A lock-holding owner periodically pings its own socket path with a
 * fresh client connection; after consecutive failures (socket file deleted,
 * lost serve takeover, or a foreign process answering with a different
 * ownerId) it authoritatively re-serves the socket. Without this, an owner can
 * hold the database while being unreachable — the split-brain that strands
 * every relaunch attempt.
 */

import { probeLockHolderOwner } from './owner-split-brain.js';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_FAILURES_BEFORE_RESERVE = 2;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

export interface OwnerSocketSentinel {
  start(): void;
  stop(): void;
  /** Run one probe/re-serve cycle. Exposed for tests. */
  tick(): Promise<void>;
}

export interface OwnerSocketSentinelDeps {
  reserve: () => void;
  log: (level: string, message: string) => void;
  expectedOwnerId?: string;
  probe?: () => Promise<boolean>;
  intervalMs?: number;
  failuresBeforeReserve?: number;
  probeTimeoutMs?: number;
}

export function createOwnerSocketSentinel(deps: OwnerSocketSentinelDeps): OwnerSocketSentinel {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const failuresBeforeReserve = deps.failuresBeforeReserve ?? DEFAULT_FAILURES_BEFORE_RESERVE;
  const probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probe = deps.probe ?? (async () => {
    const result = await probeLockHolderOwner({ timeoutMs: probeTimeoutMs });
    if (result.kind !== 'owner-alive') return false;
    return deps.expectedOwnerId === undefined || result.ownerId === deps.expectedOwnerId;
  });

  let consecutiveFailures = 0;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      let reachable = false;
      try {
        reachable = await probe();
      } catch {
        reachable = false;
      }
      if (reachable) {
        if (consecutiveFailures >= failuresBeforeReserve) {
          deps.log('info', '[owner-socket-sentinel] owner socket is reachable again');
        }
        consecutiveFailures = 0;
        return;
      }
      consecutiveFailures++;
      if (consecutiveFailures < failuresBeforeReserve) {
        deps.log(
          'warn',
          `[owner-socket-sentinel] owner socket probe failed (${consecutiveFailures}/${failuresBeforeReserve})`,
        );
        return;
      }
      deps.log(
        'warn',
        `[owner-socket-sentinel] owner socket unreachable ${consecutiveFailures} consecutive times — re-serving as writer-lock holder`,
      );
      deps.reserve();
    } finally {
      busy = false;
    }
  };

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
