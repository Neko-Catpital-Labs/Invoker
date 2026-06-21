import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { resolveRepoRoot } from '@invoker/contracts';
import { IpcBus } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';

import { resolveInvokerHomeRoot } from './delete-all-snapshot.js';
import { isHeadlessMutatingCommand } from './headless-command-classification.js';
import {
  resolveDelegationTimeoutMs,
  tryDelegateExec,
  tryDelegateQuery,
  tryDelegateQueryUiPerf,
  tryDelegateResume,
  tryDelegateRun,
  type DelegationOutcome,
} from './headless-delegation.js';
import {
  spawnDetachedStandaloneOwner,
  tryAcquireOwnerBootstrapLock,
} from './headless-owner-bootstrap.js';
import { loadConfig } from './config.js';
import {
  discoverOwner,
  isStandaloneCapable,
} from './owner-endpoint.js';
import { createOwnerResolver, type ResolvedOwner } from './owner-resolver.js';
import { createRecoveryWorker } from './worker-runtime.js';

const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const repoRoot = resolveRepoRoot(__dirname);

function delegationClientLog(message: string): void {
  process.stderr.write(`[headless-client] ${message}\n`);
}

export function electronCommandArgs(args: string[], platform: NodeJS.Platform = process.platform): string[] {
  const mainJs = resolve(__dirname, 'main.js');
  return [
    ...(platform === 'linux'
      ? [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-gpu-compositing',
          '--disable-gpu-sandbox',
          '--disable-software-rasterizer',
        ]
      : []),
    mainJs,
    '--headless',
    ...args,
  ];
}

async function runElectronHeadless(args: string[]): Promise<number> {
  const electronLauncher = resolve(repoRoot, 'scripts', 'electron.cjs');
  const nodeArgs = [electronLauncher, ...electronCommandArgs(args)];
  const command = process.platform === 'linux' && !process.env.DISPLAY ? 'xvfb-run' : process.execPath;
  const commandArgs = command === 'xvfb-run'
    ? ['--auto-servernum', process.execPath, ...nodeArgs]
    : nodeArgs;
  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      LIBGL_ALWAYS_SOFTWARE: process.platform === 'linux' ? '1' : process.env.LIBGL_ALWAYS_SOFTWARE,
    },
  });
  return await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`headless electron exited with signal ${signal}`));
        return;
      }
      resolveExit(code ?? 0);
    });
  });
}

async function flushOutputStream(stream: NodeJS.WriteStream): Promise<void> {
  await new Promise<void>((resolve) => {
    stream.write('', () => resolve());
  });
}

const DEFAULT_NO_TRACK_DELEGATION_TIMEOUT_MS = 30_000;
const POST_BOOTSTRAP_NO_TRACK_DELEGATION_TIMEOUT_MS = 90_000;
const POST_BOOTSTRAP_OWNER_READY_TIMEOUT_MS = 20_000;
const READ_ONLY_QUERY_OWNER_READY_TIMEOUT_MS = 20_000;
const READ_ONLY_QUERY_REQUEST_TIMEOUT_MS = 8_000;
const POST_BOOTSTRAP_OWNER_RESTART_ATTEMPTS = 3;
const DEFAULT_STANDALONE_OWNER_BOOTSTRAP_TIMEOUT_MS = 60_000;

const workerLogger = {
  debug() {},
  info(message: string) { process.stderr.write(`${message}\n`); },
  warn(message: string) { process.stderr.write(`${message}\n`); },
  error(message: string) { process.stderr.write(`${message}\n`); },
  child() { return workerLogger; },
};

function standaloneOwnerBootstrapTimeoutMs(): number {
  const raw = process.env.INVOKER_HEADLESS_OWNER_BOOTSTRAP_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_STANDALONE_OWNER_BOOTSTRAP_TIMEOUT_MS;
}

export class SharedMutationOwnerTimeoutError extends Error {
  constructor(message: string = 'Timed out waiting for a standalone shared mutation owner to become available') {
    super(message);
    this.name = 'SharedMutationOwnerTimeoutError';
  }
}

export function isSharedMutationOwnerTimeoutError(error: unknown): error is SharedMutationOwnerTimeoutError {
  return error instanceof SharedMutationOwnerTimeoutError;
}

async function delegateMutation(
  args: string[],
  bus: MessageBus,
  waitForApproval?: boolean,
  noTrack?: boolean,
  noTrackTimeoutMs: number = DEFAULT_NO_TRACK_DELEGATION_TIMEOUT_MS,
): Promise<DelegationOutcome> {
  const command = args[0];
  const timeoutMs = noTrack
    ? noTrackTimeoutMs
    : command === 'run' || command === 'resume'
      ? 5_000
      : await resolveDelegationTimeoutMs(args);
  delegationClientLog(
    `delegateMutation command=${command ?? '<missing>'} timeoutMs=${timeoutMs} noTrack=${noTrack ? 'true' : 'false'} waitForApproval=${waitForApproval ? 'true' : 'false'}`,
  );
  if (command === 'run') {
    const planPath = args[1];
    if (!planPath) throw new Error('Missing plan file. Usage: --headless run <plan.yaml>');
    return tryDelegateRun(planPath, bus, waitForApproval, noTrack, timeoutMs);
  }
  if (command === 'resume') {
    const workflowId = args[1];
    if (!workflowId) throw new Error('Missing workflowId. Usage: --headless resume <id>');
    return tryDelegateResume(workflowId, bus, waitForApproval, noTrack, timeoutMs);
  }
  return tryDelegateExec(args, bus, waitForApproval, noTrack, timeoutMs);
}

async function delegateReadOnlyQuery(
  args: string[],
  bus: MessageBus,
  refreshMessageBus?: () => Promise<MessageBus>,
): Promise<boolean> {
  const isUiPerf = args[0] === 'query' && args[1] === 'ui-perf';
  const isQueue = (args[0] === 'query' && args[1] === 'queue') || args[0] === 'queue';
  const isActionGraph = args[0] === 'query' && args[1] === 'action-graph';
  if (!isUiPerf && !isQueue && !isActionGraph) {
    return false;
  }

  // Use the resolver to wait for any reachable owner
  const resolver = createOwnerResolver(
    { messageBus: bus, refreshMessageBus, ensureStandaloneOwner: async () => {} },
    { discoveryTimeoutMs: 2_000 },
  );
  const ownerResult = await resolver.waitForAny(READ_ONLY_QUERY_OWNER_READY_TIMEOUT_MS);
  if (!ownerResult.resolved) {
    throw new Error(isUiPerf
      ? 'query ui-perf requires a running shared owner process'
      : isActionGraph
        ? 'query action-graph requires a running shared owner process'
        : 'query queue requires a running shared owner process');
  }

  let messageBus = ownerResult.bus;
  const deadline = Date.now() + READ_ONLY_QUERY_OWNER_READY_TIMEOUT_MS;
  let response: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    if (isUiPerf) {
      const reset = args.includes('--reset');
      response = await tryDelegateQueryUiPerf(messageBus, reset, READ_ONLY_QUERY_REQUEST_TIMEOUT_MS);
    } else if (isActionGraph) {
      response = await tryDelegateQuery(messageBus, { kind: 'action-graph' }, READ_ONLY_QUERY_REQUEST_TIMEOUT_MS);
    } else {
      response = await tryDelegateQuery(messageBus, { kind: 'queue' }, READ_ONLY_QUERY_REQUEST_TIMEOUT_MS);
    }
    if (response) break;
    if (refreshMessageBus) {
      messageBus = await refreshMessageBus();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!response) {
    throw new Error(isUiPerf
      ? 'Live owner is present but did not serve ui-perf query'
      : isActionGraph
        ? 'Live owner is present but did not serve action-graph query'
        : 'Live owner is present but did not serve queue query');
  }
  if (isUiPerf || isActionGraph) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return true;
  }
  const outputIndex = args.indexOf('--output');
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const running = Array.isArray(response.running) ? response.running as Array<Record<string, unknown>> : [];
  const queued = Array.isArray(response.queued) ? response.queued as Array<Record<string, unknown>> : [];
  if (output === 'json') {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } else if (output === 'jsonl') {
    for (const task of running) {
      process.stdout.write(`${JSON.stringify({ ...task, state: 'running' })}\n`);
    }
    for (const task of queued) {
      process.stdout.write(`${JSON.stringify({ ...task, state: 'queued' })}\n`);
    }
  } else if (output === 'label') {
    const ids = [...running, ...queued].map((task) => String(task.taskId ?? '')).filter(Boolean);
    process.stdout.write(`${ids.join('\n')}\n`);
  } else {
    const runningCount = Number(response.runningCount ?? running.length);
    const maxConcurrency = Number(response.maxConcurrency ?? 0);
    process.stdout.write(`running=${runningCount}/${maxConcurrency} queued=${queued.length}\n`);
  }
  return true;
}

export interface HeadlessClientDeps {
  messageBus: MessageBus;
  ensureStandaloneOwner: (bus?: MessageBus) => Promise<void>;
  refreshMessageBus?: () => Promise<MessageBus>;
  runElectronHeadless: (args: string[]) => Promise<number>;
}

async function ensureStandaloneOwnerViaBootstrap(bus: MessageBus): Promise<void> {
  const invokerHomeRoot = resolveInvokerHomeRoot();
  const bootstrapLock = tryAcquireOwnerBootstrapLock(invokerHomeRoot);
  const startedAt = Date.now();
  delegationClientLog(`bootstrap begin lockAcquired=${bootstrapLock ? 'true' : 'false'} home=${invokerHomeRoot}`);
  try {
    if (bootstrapLock) {
      delegationClientLog('bootstrap spawning detached standalone owner');
      spawnDetachedStandaloneOwner(repoRoot);
    }
    const deadline = Date.now() + standaloneOwnerBootstrapTimeoutMs();
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts += 1;
      const owner = await discoverOwner(bus, 500);
      if (isStandaloneCapable(owner)) {
        delegationClientLog(
          `bootstrap owner ready attempts=${attempts} elapsedMs=${Date.now() - startedAt} ownerId=${owner.ownerId}`,
        );
        return;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
    delegationClientLog(`bootstrap timeout elapsedMs=${Date.now() - startedAt}`);
    throw new SharedMutationOwnerTimeoutError();
  } finally {
    bootstrapLock?.release();
    delegationClientLog(`bootstrap end elapsedMs=${Date.now() - startedAt}`);
  }
}

function parseArgs(argv: string[]): { args: string[]; waitForApproval?: boolean; noTrack?: boolean } {
  const args: string[] = [];
  let waitForApproval = false;
  let noTrack = false;
  for (const arg of argv) {
    if (arg === '--wait-for-approval') {
      waitForApproval = true;
    } else if (arg === '--no-track' || arg === '--do-not-track') {
      noTrack = true;
    } else {
      args.push(arg);
    }
  }
  return { args, waitForApproval, noTrack };
}

function shouldUseSharedMutationOwner(args: string[], standaloneMode: boolean, internalOwnerServe: boolean): boolean {
  return isHeadlessMutatingCommand(args) && !standaloneMode && !internalOwnerServe;
}

function isAutofixWorkerCommand(args: string[]): boolean {
  return args[0] === 'worker' && args[1] === 'autofix';
}

function parseAutofixWorkerOptions(args: string[]): { count: number | undefined; intervalMs: number | undefined } {
  let count: number | undefined;
  let intervalMs: number | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--count') {
      const value = args[index + 1];
      if (!value) throw new Error('Missing value for --count');
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid --count value: ${value}`);
      }
      count = parsed;
      index += 1;
    } else if (arg === '--interval-ms') {
      const value = args[index + 1];
      if (!value) throw new Error('Missing value for --interval-ms');
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --interval-ms value: ${value}`);
      }
      intervalMs = parsed;
      index += 1;
    } else {
      throw new Error(`Unknown worker autofix option: ${arg}`);
    }
  }
  return { count, intervalMs };
}

async function resolveOwnerForAutofixWorker(deps: HeadlessClientDeps): Promise<ResolvedOwner> {
  const resolver = createOwnerResolver(
    {
      messageBus: deps.messageBus,
      refreshMessageBus: deps.refreshMessageBus,
      ensureStandaloneOwner: deps.ensureStandaloneOwner,
      isRetryableBootstrapError: isSharedMutationOwnerTimeoutError,
    },
    {
      discoveryTimeoutMs: 3_000,
      refreshDiscoveryTimeoutMs: 1_000,
      postBootstrapReadyTimeoutMs: POST_BOOTSTRAP_OWNER_READY_TIMEOUT_MS,
      maxBootstrapAttempts: POST_BOOTSTRAP_OWNER_RESTART_ATTEMPTS,
    },
  );
  return resolver.resolve(true);
}

async function runAutofixWorkerCommand(args: string[], deps: HeadlessClientDeps): Promise<number> {
  const options = parseAutofixWorkerOptions(args);
  const resolved = await resolveOwnerForAutofixWorker(deps);
  process.stdout.write(`[worker:autofix] owner ready: ${resolved.owner.ownerId}\n`);

  const worker = createRecoveryWorker({
    logger: workerLogger,
    intervalMs: options.intervalMs,
    installSignalHandlers: options.count === undefined,
    tickOnStart: false,
  });

  if (options.count !== undefined) {
    for (let tick = 0; tick < options.count; tick += 1) {
      await worker.tick('manual');
    }
    await worker.stop();
    process.stdout.write(options.count === 1
      ? `[worker:autofix] tick completed: ${worker.identity.instanceId}\n`
      : `[worker:autofix] ticks completed: ${options.count}: ${worker.identity.instanceId}\n`);
    return 0;
  }

  worker.start();
  process.stdout.write(`[worker:autofix] started: ${worker.identity.instanceId}\n`);
  await new Promise<void>((resolveStop) => {
    const finish = (): void => resolveStop();
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
  await worker.stop();
  return 0;
}

/**
 * Resolve a writable owner endpoint using the resolver, then delegate.
 *
 * This function encapsulates the discover → fallback → bootstrap → delegate
 * policy. Each phase consumes the typed DelegationOutcome to decide its
 * branch behavior:
 *
 *   - delegated     → success, return exit code
 *   - protocol-error → fail fast (owner responded but shape is invalid)
 *   - timeout        → owner may be overloaded, retry after refresh
 *   - no-handler     → no owner process registered, skip to bootstrap
 */
async function resolveOwnerAndDelegate(
  args: string[],
  deps: HeadlessClientDeps,
  waitForApproval?: boolean,
  noTrack?: boolean,
): Promise<number | null> {
  const startedAt = Date.now();
  delegationClientLog(`resolveOwnerAndDelegate begin command=${args[0] ?? '<missing>'} noTrack=${noTrack ? 'true' : 'false'}`);
  const resolvedExitCode = (): number => {
    const exitCode = process.exitCode;
    return typeof exitCode === 'number' ? exitCode : 0;
  };

  const resolver = createOwnerResolver(
    {
      messageBus: deps.messageBus,
      refreshMessageBus: deps.refreshMessageBus,
      ensureStandaloneOwner: deps.ensureStandaloneOwner,
      isRetryableBootstrapError: isSharedMutationOwnerTimeoutError,
    },
    {
      discoveryTimeoutMs: 3_000,
      refreshDiscoveryTimeoutMs: 1_000,
      postBootstrapReadyTimeoutMs: POST_BOOTSTRAP_OWNER_READY_TIMEOUT_MS,
      maxBootstrapAttempts: POST_BOOTSTRAP_OWNER_RESTART_ATTEMPTS,
    },
  );

  for (let attempt = 0; attempt < POST_BOOTSTRAP_OWNER_RESTART_ATTEMPTS; attempt += 1) {
    delegationClientLog(`resolve attempt=${attempt + 1}/${POST_BOOTSTRAP_OWNER_RESTART_ATTEMPTS}`);
    let resolved: ResolvedOwner;
    try {
      resolved = await resolver.resolve(true);
    } catch (err) {
      if (err instanceof Error && /Could not resolve a standalone-capable owner/.test(err.message)) {
        delegationClientLog(`resolve attempt failed: ${err.message}`);
        return null;
      }
      throw err;
    }
    delegationClientLog(`resolved standalone ownerId=${resolved.owner.ownerId}`);

    const outcome = await delegateMutation(
      args,
      resolved.bus,
      waitForApproval,
      noTrack,
      noTrack ? POST_BOOTSTRAP_NO_TRACK_DELEGATION_TIMEOUT_MS : DEFAULT_NO_TRACK_DELEGATION_TIMEOUT_MS,
    );
    delegationClientLog(`delegate outcome=${outcome.kind} attempt=${attempt + 1}`);
    if (outcome.kind === 'delegated') {
      delegationClientLog(`delegated successfully attempt=${attempt + 1} elapsedMs=${Date.now() - startedAt}`);
      return resolvedExitCode();
    }
    if (outcome.kind === 'protocol-error') {
      delegationClientLog(`protocol-error attempt=${attempt + 1}: ${outcome.message}`);
      return null;
    }
    if (!deps.refreshMessageBus) {
      break;
    }
  }

  delegationClientLog(`resolveOwnerAndDelegate failed after elapsedMs=${Date.now() - startedAt}`);
  return null; // Could not resolve
}

export async function runHeadlessClientCommand(
  argv: string[],
  deps: HeadlessClientDeps,
): Promise<number> {
  // Validate config before any delegation path so malformed JSON fails fast
  // even for commands that do not boot the full Electron owner process.
  loadConfig();

  const { args, waitForApproval, noTrack } = parseArgs(argv);
  const standaloneMode = process.env.INVOKER_HEADLESS_STANDALONE === '1';
  const internalOwnerServe = args[0] === 'owner-serve';

  if (isAutofixWorkerCommand(args)) {
    return runAutofixWorkerCommand(args, deps);
  }

  if (!standaloneMode && !internalOwnerServe && await delegateReadOnlyQuery(args, deps.messageBus, deps.refreshMessageBus)) {
    const exitCode = process.exitCode;
    return typeof exitCode === 'number' ? exitCode : 0;
  }

  if (!shouldUseSharedMutationOwner(args, standaloneMode, internalOwnerServe)) {
    return deps.runElectronHeadless(argv);
  }

  const result = await resolveOwnerAndDelegate(args, deps, waitForApproval, noTrack);
  if (result !== null) {
    return result;
  }

  process.stderr.write(
    `${RED}Error:${RESET} Mutation command "${args[0] ?? ''}" could not reach a standalone shared owner after bootstrap.\n`,
  );
  return 1;
}

export async function runHeadlessClient(argv: string[]): Promise<number> {
  let bus = new IpcBus(undefined, { allowServe: false });
  const refreshMessageBus = async (): Promise<MessageBus> => {
    bus.disconnect();
    bus = new IpcBus(undefined, { allowServe: false });
    await bus.ready();
    return bus;
  };
  try {
    await bus.ready();
    return await runHeadlessClientCommand(argv, {
      messageBus: bus,
      ensureStandaloneOwner: (currentBus) => ensureStandaloneOwnerViaBootstrap(currentBus ?? bus),
      refreshMessageBus,
      runElectronHeadless,
    });
  } finally {
    bus.disconnect();
  }
}

if (require.main === module) {
  runHeadlessClient(process.argv.slice(2))
    .then(async (code) => {
      await Promise.all([
        flushOutputStream(process.stdout),
        flushOutputStream(process.stderr),
      ]);
      process.exitCode = code;
    })
    .catch(async (err) => {
      process.stderr.write(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
      await Promise.all([
        flushOutputStream(process.stdout),
        flushOutputStream(process.stderr),
      ]);
      process.exitCode = 1;
    });
}
