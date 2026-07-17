import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

import { resolveRepoRoot, type WorkerStatusSnapshot } from '@invoker/contracts';
import { hasLiveWritableOwner } from '@invoker/data-store';
import { IpcBus } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import {
  createWorkerRegistry,
  registerBuiltinWorkers,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';

import { resolveInvokerHomeRoot } from './delete-all-snapshot.js';
import { isHeadlessMutatingCommand } from './headless-command-classification.js';
import {
  resolveDelegationTimeoutMs,
  tryDelegateExec,
  tryDelegateQuery,
  tryDelegateQueryUiPerf,
  tryDelegateResume,
  tryDelegateRun,
  tryPingHeadlessOwner,
  type DelegationOutcome,
} from './headless-delegation.js';
import {
  spawnDetachedStandaloneOwner,
  tryAcquireOwnerBootstrapLock,
} from './headless-owner-bootstrap.js';
import { loadConfig, type InvokerConfig } from './config.js';
import { registerExternalWorkersFromConfig } from './external-worker-loader.js';
import {
  discoverOwner,
  isStandaloneCapable,
} from './owner-endpoint.js';
import { createOwnerResolver, type ResolvedOwner } from './owner-resolver.js';
import { AUTO_STARTED_OWNER_WORKER_KINDS, createLocalWorkerStatusSnapshot } from './worker-control.js';
import { resolveWorkerControlMutation } from './worker-control-delegation.js';
import { openMainProcessDatabase } from './viewer-db-boundary.js';
import {
  canAcknowledgeNoTrackTaskMutationWithoutDb,
  tryAcknowledgeNoTrackTaskMutationWithoutDb,
  tryAcknowledgeNoTrackTaskMutationWithoutOwner,
} from './headless-no-track-fallback.js';

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
const OPTIONAL_READ_ONLY_QUERY_OWNER_READY_TIMEOUT_MS = 2_000;
const READ_ONLY_QUERY_REQUEST_TIMEOUT_MS = 15_000;
const GENERIC_READ_OWNER_PING_TIMEOUT_MS = 10_000;
const POST_BOOTSTRAP_OWNER_RESTART_ATTEMPTS = 3;
const DEFAULT_STANDALONE_OWNER_BOOTSTRAP_TIMEOUT_MS = 60_000;

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

const STALE_OWNER_NO_TRACK_TASK_COMMANDS = new Set([
  'retry-task',
  'recreate-task',
]);

function explicitTaskTargetWorkflowId(args: string[]): string | undefined {
  const target = args[1];
  if (!target) return undefined;
  const slashIndex = target.indexOf('/');
  if (slashIndex <= 0) return undefined;
  const workflowId = target.slice(0, slashIndex);
  return /^wf-[^/]+$/.test(workflowId) ? workflowId : undefined;
}

function isForeignKeyConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const sqliteError = error as Error & { code?: unknown; errcode?: unknown; errstr?: unknown };
  return sqliteError.errcode === 787
    || sqliteError.message.includes('FOREIGN KEY constraint failed');
}

function isExecutionPoolCapacityError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('Execution pool')
    && error.message.includes('has no member capacity available');
}

function isAcceptedStaleOwnerNoTrackTaskMutationError(
  args: string[],
  noTrack: boolean | undefined,
  error: unknown,
): boolean {
  const command = args[0];
  return noTrack === true
    && command !== undefined
    && STALE_OWNER_NO_TRACK_TASK_COMMANDS.has(command)
    && explicitTaskTargetWorkflowId(args) !== undefined
    && (isForeignKeyConstraintError(error) || isExecutionPoolCapacityError(error));
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

const GENERIC_DELEGATABLE_READ_COMMANDS = new Set([
  'list', 'status', 'task-status', 'audit', 'session', 'query-select',
]);

/**
 * Read-only query commands the owner can answer over the generic `cli-query`
 * channel. `queue`, `ui-perf`, and `action-graph` are excluded here — they have
 * bespoke owner-required handling in {@link delegateReadOnlyQuery}.
 */
function isGenericDelegatableReadCommand(args: string[]): boolean {
  const command = args[0];
  if (command === 'query') {
    const sub = args[1];
    return sub !== undefined && sub !== 'workers' && sub !== 'queue' && sub !== 'ui-perf' && sub !== 'action-graph';
  }
  return command !== undefined && GENERIC_DELEGATABLE_READ_COMMANDS.has(command);
}

/**
 * Delegate a read-only query to the writable owner so this process never opens
 * the database file. Returns false when the command is not delegatable or no
 * owner is present, letting the caller open the database directly (it is then
 * the sole opener — safe).
 */
async function delegateGenericReadQuery(
  args: string[],
  bus: MessageBus,
  refreshMessageBus?: () => Promise<MessageBus>,
): Promise<boolean> {
  if (!isGenericDelegatableReadCommand(args)) return false;

  let messageBus = bus;
  let owner = await discoverOwner(messageBus, GENERIC_READ_OWNER_PING_TIMEOUT_MS);
  if (!owner && refreshMessageBus) {
    messageBus = await refreshMessageBus();
    owner = await discoverOwner(messageBus, GENERIC_READ_OWNER_PING_TIMEOUT_MS);
  }
  if (!owner && !hasLiveWritableOwner(resolve(resolveInvokerHomeRoot(), 'invoker.db'))) return false;

  const deadline = Date.now() + READ_ONLY_QUERY_OWNER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await tryDelegateQuery(
      messageBus,
      { kind: 'cli-query', args },
      READ_ONLY_QUERY_REQUEST_TIMEOUT_MS,
    );
    if (response && typeof response.output === 'string') {
      process.stdout.write(response.output);
      return true;
    }
    if (!refreshMessageBus) break;
    messageBus = await refreshMessageBus();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Live owner is present but did not serve cli-query');
}

async function delegateWorkerControl(
  args: string[],
  bus: MessageBus,
  refreshMessageBus?: () => Promise<MessageBus>,
): Promise<boolean> {
  const mutation = resolveWorkerControlMutation(args);
  if (!mutation) return false;

  let messageBus = bus;
  let owner = await discoverOwner(messageBus, GENERIC_READ_OWNER_PING_TIMEOUT_MS);
  if (!owner && refreshMessageBus) {
    messageBus = await refreshMessageBus();
    owner = await discoverOwner(messageBus, GENERIC_READ_OWNER_PING_TIMEOUT_MS);
  }
  if (!owner) {
    throw new Error(`No running Invoker owner found to ${mutation.action} the "${mutation.kind}" worker. Start the app first.`);
  }

  const result = await messageBus.request('headless.gui-mutation', {
    channel: mutation.channel,
    args: [mutation.kind],
  });
  process.stdout.write(`[headless] worker ${mutation.action} "${mutation.kind}" accepted by owner: ${JSON.stringify(result)}\n`);
  return true;
}

function shouldBootstrapStandaloneReadQuery(
  args: string[],
  standaloneMode: boolean,
  internalOwnerServe: boolean,
): boolean {
  if (!standaloneMode || internalOwnerServe) return false;
  const isSpecialRead =
    (args[0] === 'query' && (args[1] === 'queue' || args[1] === 'ui-perf' || args[1] === 'action-graph'))
    || args[0] === 'queue';
  return isSpecialRead;
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
    return delegateGenericReadQuery(args, bus, refreshMessageBus);
  }
  if (isUiPerf && args.includes('--reset')) {
    throw new Error('query ui-perf --reset is not a read-only query');
  }

  // Use the resolver to wait for any reachable owner
  const resolver = createOwnerResolver(
    { messageBus: bus, refreshMessageBus, ensureStandaloneOwner: async () => {} },
    { discoveryTimeoutMs: 2_000 },
  );
  const ownerResult = await resolver.waitForAny(
    isUiPerf ? READ_ONLY_QUERY_OWNER_READY_TIMEOUT_MS : OPTIONAL_READ_ONLY_QUERY_OWNER_READY_TIMEOUT_MS,
  );
  if (!ownerResult.resolved) {
    if (isQueue || isActionGraph) return false;
    throw new Error(isUiPerf
      ? 'query ui-perf requires a running shared owner process'
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
    if (isActionGraph) return false;
    throw new Error(isUiPerf
      ? 'Live owner is present but did not serve ui-perf query'
      : 'Live owner is present but did not serve queue query');
  }
  if (isActionGraph) {
    const outputIndex = args.indexOf('--output');
    const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
    const nodes = Array.isArray(response.nodes) ? response.nodes as Array<Record<string, unknown>> : [];
    const edges = Array.isArray(response.edges) ? response.edges as Array<Record<string, unknown>> : [];
    if (output === 'label') {
      process.stdout.write(nodes.map((node) => String(node.id ?? '')).filter(Boolean).join('\n') + '\n');
    } else if (output === 'jsonl') {
      for (const node of nodes) process.stdout.write(`${JSON.stringify({ kind: 'node', ...node })}\n`);
      for (const edge of edges) process.stdout.write(`${JSON.stringify({ kind: 'edge', ...edge })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
    return true;
  }
  if (isUiPerf) {
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

function isLocalWorkersQuery(args: string[]): boolean {
  return args[0] === 'query' && args[1] === 'workers';
}

function readOutputFormat(args: string[]): string | undefined {
  const outputIndex = args.indexOf('--output');
  if (outputIndex < 0) return undefined;
  return args[outputIndex + 1];
}

function writeWorkerSnapshot(snapshot: WorkerStatusSnapshot, args: string[]): void {
  const output = readOutputFormat(args);
  if (output === 'label') {
    process.stdout.write(`${snapshot.workers.map((worker) => worker.kind).join('\n')}\n`);
    return;
  }
  if (output === 'jsonl') {
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    return;
  }
  if (output === 'json') {
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    return;
  }

  process.stdout.write(`Workers\n`);
  process.stdout.write(`  generatedAt: ${snapshot.generatedAt}\n`);
  process.stdout.write(`  count: ${snapshot.workers.length}\n`);
  for (const worker of snapshot.workers) {
    const source = worker.source ? ` · ${worker.source}` : '';
    process.stdout.write(`  - ${worker.kind}: ${worker.lifecycle} · ${worker.policy}${source}\n`);
  }
}

async function runLocalWorkersQuery(args: string[], invokerConfig: InvokerConfig): Promise<number> {
  const dbPath = join(resolveInvokerHomeRoot(), 'invoker.db');
  const persistence = await openMainProcessDatabase({
    dbPath,
    detachedViewer: false,
    readOnly: true,
    exclusiveLocking: false,
  });
  try {
    const registry = registerExternalWorkersFromConfig(
      invokerConfig.externalWorkers,
      registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>()),
    );
    const snapshot = createLocalWorkerStatusSnapshot({
      registry,
      persistence,
      autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
    });
    writeWorkerSnapshot(snapshot, args);
    return 0;
  } finally {
    persistence.close();
  }
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

    let outcome: DelegationOutcome;
    try {
      outcome = await delegateMutation(
        args,
        resolved.bus,
        waitForApproval,
        noTrack,
        noTrack ? POST_BOOTSTRAP_NO_TRACK_DELEGATION_TIMEOUT_MS : DEFAULT_NO_TRACK_DELEGATION_TIMEOUT_MS,
      );
    } catch (err) {
      if (isAcceptedStaleOwnerNoTrackTaskMutationError(args, noTrack, err)) {
        delegationClientLog(
          `accepted stale-owner no-track task mutation command=${args[0]} workflow=${explicitTaskTargetWorkflowId(args)}`,
        );
        process.stdout.write('Delegated to owner\n');
        process.stdout.write('--no-track enabled: delegated submission accepted; exiting without tracking.\n');
        return resolvedExitCode();
      }
      throw err;
    }
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
  const invokerConfig = loadConfig();

  const { args, waitForApproval, noTrack } = parseArgs(argv);
  const standaloneMode = process.env.INVOKER_HEADLESS_STANDALONE === '1';
  const internalOwnerServe = args[0] === 'owner-serve';

  if (!internalOwnerServe && await delegateWorkerControl(args, deps.messageBus, deps.refreshMessageBus)) {
    const exitCode = process.exitCode;
    return typeof exitCode === 'number' ? exitCode : 0;
  }

  if (!internalOwnerServe && await delegateReadOnlyQuery(args, deps.messageBus, deps.refreshMessageBus)) {
    const exitCode = process.exitCode;
    return typeof exitCode === 'number' ? exitCode : 0;
  }
  if (shouldBootstrapStandaloneReadQuery(args, standaloneMode, internalOwnerServe)) {
    await deps.ensureStandaloneOwner(deps.messageBus);
    const delegatedAfterBootstrap = await delegateReadOnlyQuery(
      args,
      deps.refreshMessageBus ? await deps.refreshMessageBus() : deps.messageBus,
      deps.refreshMessageBus,
    );
    if (delegatedAfterBootstrap) {
      const exitCode = process.exitCode;
      return typeof exitCode === 'number' ? exitCode : 0;
    }
  }

  if (!internalOwnerServe && isLocalWorkersQuery(args)) {
    return runLocalWorkersQuery(args, invokerConfig);
  }

  if (!shouldUseSharedMutationOwner(args, standaloneMode, internalOwnerServe)) {
    return deps.runElectronHeadless(argv);
  }

  if (canAcknowledgeNoTrackTaskMutationWithoutDb(args, noTrack)) {
    const owner = await discoverOwner(deps.messageBus, 500);
    if (owner === null && tryAcknowledgeNoTrackTaskMutationWithoutDb(args, noTrack)) {
      return 0;
    }
  }

  const result = await resolveOwnerAndDelegate(args, deps, waitForApproval, noTrack);
  if (result !== null) {
    return result;
  }

  if (await tryAcknowledgeNoTrackTaskMutationWithoutOwner(args, noTrack)) {
    return 0;
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
