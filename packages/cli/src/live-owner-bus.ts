import {
  IpcBus,
  TransportError,
  TransportErrorCode,
  type MessageBus,
} from '@invoker/transport';
import { logCaughtException } from './logging.js';

export type LiveOwnerInfo = {
  ownerId: string;
  mode: string;
};

export function createTraceId(channel: string): string {
  return `${channel}:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const TIMEOUT = Symbol('timeout');
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolveTimeout) => {
    timeoutHandle = setTimeout(() => resolveTimeout(TIMEOUT), timeoutMs);
    timeoutHandle.unref?.();
  });
  try {
    const result = await Promise.race([promise, timeout]);
    if (result === TIMEOUT) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    return result as T;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function discoverLiveOwner(bus: MessageBus, timeoutMs = 10_000): Promise<LiveOwnerInfo | null> {
  try {
    const raw = await withTimeout(
      bus.request('headless.owner-ping', {}),
      timeoutMs,
    );
    if (!raw || typeof raw !== 'object') return null;
    const response = raw as Record<string, unknown>;
    if (typeof response.mode !== 'string' || response.mode.length === 0) {
      return null;
    }
    return {
      ownerId: typeof response.ownerId === 'string' ? response.ownerId : '',
      mode: response.mode,
    };
  } catch (err) {
    if (err instanceof TransportError && err.code === TransportErrorCode.NO_HANDLER) {
      logCaughtException('Live owner discovery has no handler; falling back to standalone mode', err);
      return null;
    }
    if (err instanceof Error && err.message.startsWith('Timed out after ')) {
      logCaughtException('Live owner discovery timed out; falling back to standalone mode', err);
      return null;
    }
    logCaughtException('Live owner discovery failed; falling back to standalone mode', err);
    return null;
  }
}

export async function createDefaultMessageBus(): Promise<MessageBus> {
  const bus = new IpcBus(undefined, { allowServe: false });
  await bus.ready();
  return bus;
}
