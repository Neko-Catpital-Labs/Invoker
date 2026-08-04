/**
 * Split-brain handling for owner-serve startup.
 *
 * When a spawned owner loses the DB writer lock to a live PID, the holder is
 * either a healthy owner already answering IPC (spawn is redundant — exit 0),
 * or a process holding the database without serving the socket (split-brain —
 * exit 1 with a distinct, actionable error). Probing before dying is what lets
 * supervisors (slack-manager watchdog) distinguish "owner already running"
 * from "recovery is impossible until PID X dies".
 */

import { IpcBus } from '@invoker/transport';

export const OWNER_SPLIT_BRAIN_PREFIX = '[owner-split-brain]';

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

export interface OwnerPingAnswer {
  ok?: boolean;
  ownerId?: string;
  mode?: string;
}

export interface ProbeBus {
  ready(): Promise<void>;
  request<Req, Res>(channel: string, message: Req): Promise<Res>;
  disconnect(): void;
}

export type LockHolderProbeResult =
  | { kind: 'owner-alive'; ownerId?: string; mode?: string }
  | { kind: 'split-brain' };

export interface OwnerServeLockFailureResolution {
  exitCode: 0 | 1;
  message: string;
}

export function isWriterLockHeldError(err: unknown): boolean {
  return err instanceof Error
    && err.message.includes('[db-writer-lock]')
    && err.message.includes('already held by PID');
}

export function parseWriterLockHolderPid(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = /already held by PID (\d+)/.exec(err.message);
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  return Number.isFinite(pid) ? pid : null;
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`owner-ping probe timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function probeLockHolderOwner(options: {
  createBus?: () => ProbeBus;
  timeoutMs?: number;
} = {}): Promise<LockHolderProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const createBus = options.createBus
    ?? (() => new IpcBus(undefined, { allowServe: false, requestDeadlineMs: timeoutMs }));
  const bus = createBus();
  try {
    await raceTimeout(bus.ready(), timeoutMs);
    const res = await raceTimeout(
      bus.request<Record<string, never>, OwnerPingAnswer>('headless.owner-ping', {}),
      timeoutMs,
    );
    if (res?.ok) {
      return { kind: 'owner-alive', ownerId: res.ownerId, mode: res.mode };
    }
    return { kind: 'split-brain' };
  } catch {
    return { kind: 'split-brain' };
  } finally {
    bus.disconnect();
  }
}

export async function resolveOwnerServeLockFailure(
  err: unknown,
  socketPath: string,
  options: { createBus?: () => ProbeBus; timeoutMs?: number } = {},
): Promise<OwnerServeLockFailureResolution> {
  const probe = await probeLockHolderOwner(options);
  if (probe.kind === 'owner-alive') {
    const identity = [
      probe.ownerId ? `ownerId=${probe.ownerId}` : null,
      probe.mode ? `mode=${probe.mode}` : null,
    ].filter(Boolean).join(' ');
    return {
      exitCode: 0,
      message: `owner-serve: an owner already answers IPC${identity ? ` (${identity})` : ''}; exiting without taking over.`,
    };
  }
  const holderPid = parseWriterLockHolderPid(err);
  const holder = holderPid === null ? 'an unknown PID' : `PID ${holderPid}`;
  return {
    exitCode: 1,
    message:
      `${OWNER_SPLIT_BRAIN_PREFIX} DB writer lock is held by ${holder}, but no owner answers `
      + `headless.owner-ping at ${socketPath}. A live process holds the database without serving IPC; `
      + `relaunching cannot succeed until it exits. Stop ${holder} (e.g. close a stray Invoker GUI), then retry.`,
  };
}
