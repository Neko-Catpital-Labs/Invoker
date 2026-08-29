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

// Must stay >= the slack-manager watchdog's own owner-ping patience
// (pingTimeoutMs in packages/slack-manager/src/index.ts) -- a shorter value
// here means a merely-slow-but-alive owner can fail this probe even though
// the watchdog itself would still consider it healthy, misclassifying it as
// split-brain and spawning a redundant competing owner.
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

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
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface GuiLockConflictPrompt {
  holderPid: number | null;
  title: string;
  message: string;
  buttons: string[];
  cancelId: number;
  killButtonIndex: number | null;
}

export function buildGuiLockConflictPrompt(err: unknown): GuiLockConflictPrompt {
  const holderPid = parseWriterLockHolderPid(err);
  const title = 'Invoker is already running elsewhere';
  if (holderPid === null) {
    return {
      holderPid: null,
      title,
      message:
        'Another Invoker instance is holding the database, but it isn\'t reachable to share this window with. '
        + 'Close that instance, then relaunch Invoker.',
      buttons: ['Quit'],
      cancelId: 0,
      killButtonIndex: null,
    };
  }
  return {
    holderPid,
    title,
    message:
      `Another Invoker instance (PID ${holderPid}) is holding the database, but it isn't reachable to share `
      + 'this window with. You can quit that process and continue here, or quit this launch.',
    buttons: ['Quit Other Instance and Retry', 'Quit'],
    cancelId: 1,
    killButtonIndex: 0,
  };
}

export async function terminateAndAwaitExit(
  pid: number,
  deps: {
    terminatePid?: (pid: number) => void;
    isPidAlive?: (pid: number) => boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const terminatePid = deps.terminatePid ?? ((p: number) => process.kill(p, 'SIGTERM'));
  const alive = deps.isPidAlive ?? isPidAlive;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? 10_000;
  try {
    terminatePid(pid);
  } catch {
    return !alive(pid);
  }
  const deadline = now() + timeoutMs;
  while (now() < deadline && alive(pid)) {
    await sleep(200);
  }
  return !alive(pid);
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
