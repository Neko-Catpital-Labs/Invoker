import { resolve } from 'node:path';

import {
  IpcBus,
  TransportError,
  TransportErrorCode,
  type MessageBus,
} from '@invoker/transport';

export const THIN_IPC_CLIENT_USAGE =
  'Usage: headless-ipc-client [--headless] [--no-track] [--wait-for-approval] run <plan.yaml>';

const CONNECT_TIMEOUT_ENV = 'INVOKER_THIN_IPC_CONNECT_TIMEOUT_MS';
const RUN_TIMEOUT_ENV = 'INVOKER_THIN_IPC_RUN_TIMEOUT_MS';
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_RUN_TIMEOUT_MS = 30_000;
const CONNECT_RETRY_DELAY_MS = 25;

export interface ThinIpcRunArgs {
  readonly planPath: string;
  readonly waitForApproval: boolean;
  readonly noTrack: boolean;
}

export type ThinIpcArgsResult =
  | { kind: 'run'; args: ThinIpcRunArgs }
  | { kind: 'invalid'; reason: string };

export type ThinIpcRunOutcome =
  | { kind: 'submitted'; workflowId: string; workflowIds: string[]; planName?: string }
  | { kind: 'rejected'; reason: string };

export interface ThinIpcClientIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface ThinIpcClientDeps extends Partial<ThinIpcClientIo> {
  readonly messageBus?: MessageBus;
  readonly socketPath?: string;
  readonly connectTimeoutMs?: number;
  readonly runTimeoutMs?: number;
}

function positiveEnvMs(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseThinIpcArgs(argv: readonly string[]): ThinIpcArgsResult {
  let waitForApproval = false;
  let noTrack = false;
  const positionals: string[] = [];

  for (const arg of argv) {
    if (arg === '--headless') continue;
    if (arg === '--no-track') {
      noTrack = true;
      continue;
    }
    if (arg === '--wait-for-approval') {
      waitForApproval = true;
      continue;
    }
    if (arg.startsWith('-')) {
      return { kind: 'invalid', reason: `unsupported flag "${arg}". ${THIN_IPC_CLIENT_USAGE}` };
    }
    positionals.push(arg);
  }

  const [command, planPath, ...extra] = positionals;
  if (command === undefined) {
    return { kind: 'invalid', reason: `missing command. ${THIN_IPC_CLIENT_USAGE}` };
  }
  if (command !== 'run') {
    return {
      kind: 'invalid',
      reason: `unsupported command "${command}"; this client only submits plans. ${THIN_IPC_CLIENT_USAGE}`,
    };
  }
  if (!planPath) {
    return { kind: 'invalid', reason: `missing plan file. ${THIN_IPC_CLIENT_USAGE}` };
  }
  if (extra.length > 0) {
    return {
      kind: 'invalid',
      reason: `unexpected extra argument "${extra[0]}". ${THIN_IPC_CLIENT_USAGE}`,
    };
  }

  return { kind: 'run', args: { planPath, waitForApproval, noTrack } };
}

export function readOwnerRunAck(raw: unknown): ThinIpcRunOutcome {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      kind: 'rejected',
      reason: `owner returned ${raw === null ? 'null' : Array.isArray(raw) ? 'an array' : typeof raw} instead of a headless.run ack`,
    };
  }
  const response = raw as Record<string, unknown>;
  const workflowId = typeof response.workflowId === 'string' ? response.workflowId.trim() : '';
  if (!workflowId) {
    const keys = Object.keys(response);
    return {
      kind: 'rejected',
      reason: `owner acknowledged without a persisted workflow id (response keys: ${keys.length === 0 ? 'none' : keys.join(', ')})`,
    };
  }
  const workflowIds = Array.isArray(response.workflowIds)
    ? response.workflowIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    : [];
  const planName = typeof response.planName === 'string' && response.planName !== ''
    ? response.planName
    : undefined;
  return {
    kind: 'submitted',
    workflowId,
    workflowIds: workflowIds.length > 0 ? workflowIds : [workflowId],
    ...(planName ? { planName } : {}),
  };
}

function createTraceId(): string {
  return `headless.run:thin:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
}

function isNoHandler(error: unknown): boolean {
  return error instanceof TransportError && error.code === TransportErrorCode.NO_HANDLER;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, ms).unref?.();
  });
}

export async function waitForOwner(
  bus: MessageBus,
  timeoutMs: number,
): Promise<{ kind: 'reachable' } | { kind: 'unreachable'; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = `no owner answered headless.owner-ping within ${timeoutMs}ms`;
  while (Date.now() < deadline) {
    const fatal = bus instanceof IpcBus ? bus.getFatalConnectError() : null;
    if (fatal) return { kind: 'unreachable', reason: fatal.message };
    try {
      const pong = await bus.request<Record<string, never>, unknown>('headless.owner-ping', {});
      if (pong !== null && typeof pong === 'object') return { kind: 'reachable' };
      lastReason = `owner answered headless.owner-ping with ${pong === null ? 'null' : typeof pong}`;
    } catch (error) {
      if (!isNoHandler(error)) return { kind: 'unreachable', reason: describeError(error) };
      lastReason = describeError(error);
    }
    await delay(CONNECT_RETRY_DELAY_MS);
  }
  return { kind: 'unreachable', reason: lastReason };
}

export async function requestOwnerHeadlessRun(
  bus: MessageBus,
  args: ThinIpcRunArgs,
  runTimeoutMs: number,
): Promise<ThinIpcRunOutcome> {
  const planPath = resolve(args.planPath);
  const traceId = createTraceId();
  const RUN_TIMEOUT = Symbol('thin-ipc-run-timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof RUN_TIMEOUT>((_, reject) => {
    timer = setTimeout(() => reject(RUN_TIMEOUT), runTimeoutMs);
    timer.unref?.();
  });
  try {
    const raw = await Promise.race([
      bus.request('headless.run', {
        planPath,
        traceId,
        waitForApproval: args.waitForApproval,
        noTrack: args.noTrack,
        forceSynchronousAck: process.env.INVOKER_THIN_IPC_FORCE_SYNC_ACK === '1',
      }),
      timeout,
    ]);
    return readOwnerRunAck(raw);
  } catch (error) {
    if (error === RUN_TIMEOUT) {
      return {
        kind: 'rejected',
        reason: `owner did not ack headless.run within ${runTimeoutMs}ms (trace=${traceId})`,
      };
    }
    if (isNoHandler(error)) {
      return {
        kind: 'rejected',
        reason: `owner has no headless.run handler (trace=${traceId}): ${describeError(error)}`,
      };
    }
    return { kind: 'rejected', reason: `owner rejected headless.run (trace=${traceId}): ${describeError(error)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runHeadlessIpcClient(
  argv: readonly string[],
  deps: ThinIpcClientDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((line) => { process.stdout.write(line); });
  const stderr = deps.stderr ?? ((line) => { process.stderr.write(line); });
  const fail = (reason: string): number => {
    stderr(`[headless-ipc-client] ${reason}\n`);
    return 1;
  };

  const parsed = parseThinIpcArgs(argv);
  if (parsed.kind === 'invalid') return fail(parsed.reason);
  const runArgs: ThinIpcRunArgs = {
    ...parsed.args,
    planPath: resolve(parsed.args.planPath),
  };

  const connectTimeoutMs = deps.connectTimeoutMs
    ?? positiveEnvMs(CONNECT_TIMEOUT_ENV, DEFAULT_CONNECT_TIMEOUT_MS);
  const runTimeoutMs = deps.runTimeoutMs ?? positiveEnvMs(RUN_TIMEOUT_ENV, DEFAULT_RUN_TIMEOUT_MS);
  const ownBus = deps.messageBus
    ? undefined
    : new IpcBus(deps.socketPath, { allowServe: false, requestDeadlineMs: runTimeoutMs });
  const bus = deps.messageBus ?? ownBus!;

  try {
    if (ownBus) await ownBus.ready();
    const owner = await waitForOwner(bus, connectTimeoutMs);
    if (owner.kind === 'unreachable') {
      return fail(`no reachable owner for plan "${runArgs.planPath}": ${owner.reason}`);
    }
    const outcome = await requestOwnerHeadlessRun(bus, runArgs, runTimeoutMs);
    if (outcome.kind === 'rejected') {
      return fail(`plan "${runArgs.planPath}" was not submitted: ${outcome.reason}`);
    }
    stdout(`Workflow ID: ${outcome.workflowId}\n`);
    if (outcome.workflowIds.length > 1) {
      stdout(`Workflow IDs: ${outcome.workflowIds.join(' ')}\n`);
    }
    return 0;
  } catch (error) {
    return fail(`plan "${runArgs.planPath}" was not submitted: ${describeError(error)}`);
  } finally {
    ownBus?.disconnect();
  }
}

if (require.main === module) {
  runHeadlessIpcClient(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`[headless-ipc-client] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
