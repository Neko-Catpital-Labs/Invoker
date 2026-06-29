import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolveInvokerHomeRoot, type Logger } from '@invoker/contracts';
import { SQLiteAdapter, SqliteTaskRepository } from '@invoker/data-store';
import {
  AUTO_FIX_WORKER_KIND,
  ExecutorRegistry,
  TaskRunner,
  WorktreeExecutor,
  acquireWorkerLock,
  createWorkerRegistry,
  registerAutoFixWorker,
  WorkerLockHeldError,
  registerBuiltinAgents,
  type WorkerDefinition,
} from '@invoker/execution-engine';
import {
  IpcBus,
  TransportError,
  TransportErrorCode,
  type MessageBus,
} from '@invoker/transport';
import {
  Orchestrator,
  parsePlanFile,
  type OrchestratorMessageBus,
  type PlanDefinition,
  type TaskState,
} from '@invoker/workflow-core';
import { runMcpServer } from './mcp-server.js';
import { runDoctor, runSetup } from './onboarding.js';

const VERSION = '0.0.6';

type CliOptions = {
  dbDir?: string;
  config?: string;
  json: boolean;
  mode: 'auto' | 'live' | 'standalone';
};

type RunResult = {
  workflowId: string;
  status: 'success' | 'failed';
  completedTasks: number;
  failedTasks: number;
  mode: 'standalone' | 'live';
};

type LiveOwnerInfo = {
  ownerId: string;
  mode: string;
};

type LiveSubmissionResult = {
  workflowId: string;
  tasks: unknown[];
  ownerId?: string;
};

type CliDeps = {
  createMessageBus?: () => Promise<MessageBus> | MessageBus;
  runMcpServer?: () => Promise<void>;
};

type CliRuntimeConfig = {
  defaultBranch?: string;
  maxConcurrency?: number;
  docker?: {
    imageName?: string;
    secretsFile?: string;
  };
  remoteTargets?: Record<string, {
    host: string;
    user: string;
    sshKeyPath: string;
    port?: number;
    managedWorkspaces?: boolean;
    remoteInvokerHome?: string;
    provisionCommand?: string;
    use_api_key?: boolean;
    secretsFile?: string;
    remoteHeartbeatIntervalSeconds?: number;
  }>;
  executionPools?: Record<string, {
    members: Array<
      | { type: 'ssh'; id: string; maxConcurrentTasks?: number }
      | { type: 'worktree'; id: string; maxConcurrentTasks?: number }
    >;
    selectionStrategy?: 'roundRobin' | 'leastLoaded';
    maxConcurrentTasksPerMember?: number;
  }>;
  defaultPoolId?: string;
  executorRoutingRules?: Array<{
    pattern?: string;
    regex?: string;
    poolId: string;
    strategy?: 'enforce' | 'route';
  }>;
};

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return silentLogger; },
};

const noopBus: OrchestratorMessageBus = {
  publish() {},
};

function usage(): string {
  return [
    'Usage:',
    '  invoker-cli run <plan.yaml> [--live|--standalone] [--db-dir <path>] [--config <path>] [--json]',
    '  invoker-cli doctor [--fix] [--json]',
    '  invoker-cli setup [planner|slack] [--check] [--json]',
    '  invoker-cli mcp',
    '  invoker-cli worker [autofix|list]',
    '  invoker-cli --help',
    '  invoker-cli --version',
    '',
    'Commands:',
    '  run <plan.yaml>  Submit to a live Invoker UI when available, otherwise run standalone.',
    '  doctor          Validate tools, config, and your default planning preset.',
    '  setup [planner|slack]  Validate the environment, then optionally configure planner MCP or Slack.',
    '  mcp             Start the Invoker MCP stdio server.',
    '  worker [kind|list]  Run a registry-selected worker or list available worker kinds.',
    '',
    'Options:',
    '  --planner-url <url>   Planner service URL for `setup planner`.',
    '  --access-token <tok>  Planner service access token for `setup planner`.',
    '  --target <path>       MCP config path for `setup planner`. Defaults to ~/.omp/agent/mcp.json.',
    '  --uninstall           Remove the experimental planner MCP entry and disable its Invoker flag.',
    '  --live           Require a running Invoker UI owner and submit over IPC.',
    '  --standalone     Skip IPC and run with an isolated CLI database.',
    '  --db-dir <path>  Runtime database directory. Defaults to ~/.invoker-cli',
    '  --config <path>  Optional config path reserved for CLI runtime configuration.',
    '  --json           Emit only a machine-readable result summary on stdout.',
    '  --fix            Best-effort install of missing doctor tools.',
    '  --help           Show this help text.',
    '  --version        Show the CLI version.',
  ].join('\n');
}

function parseArgs(argv: string[]): { command?: string; planPath?: string; options: CliOptions } {
  const options: CliOptions = { json: false, mode: 'auto' };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db-dir') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --db-dir');
      options.dbDir = value;
    } else if (arg === '--config') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --config');
      options.config = value;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--live') {
      if (options.mode === 'standalone') throw new Error('Cannot combine --live and --standalone');
      options.mode = 'live';
    } else if (arg === '--standalone') {
      if (options.mode === 'live') throw new Error('Cannot combine --live and --standalone');
      options.mode = 'standalone';
    } else if (arg === '--help' || arg === '-h') {
      positional.push('--help');
    } else if (arg === '--version' || arg === '-v') {
      positional.push('--version');
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0],
    planPath: positional[1],
    options,
  };
}

function createTraceId(channel: string): string {
  return `${channel}:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
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

async function discoverLiveOwner(bus: MessageBus, timeoutMs = 1_000): Promise<LiveOwnerInfo | null> {
  try {
    const raw = await withTimeout(
      bus.request('headless.owner-ping', {}),
      timeoutMs,
    );
    if (!raw || typeof raw !== 'object') return null;
    const response = raw as Record<string, unknown>;
    if (response.mode !== 'gui') return null;
    return {
      ownerId: typeof response.ownerId === 'string' ? response.ownerId : '',
      mode: 'gui',
    };
  } catch (err) {
    if (err instanceof TransportError && err.code === TransportErrorCode.NO_HANDLER) {
      return null;
    }
    if (err instanceof Error && err.message.startsWith('Timed out after ')) {
      return null;
    }
    return null;
  }
}

function validateLiveSubmissionResponse(raw: unknown): LiveSubmissionResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Live owner returned invalid headless.run response: expected object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const response = raw as Record<string, unknown>;
  if (typeof response.workflowId !== 'string' || response.workflowId.length === 0) {
    throw new Error('Live owner returned invalid headless.run response: missing workflowId');
  }
  if (!Array.isArray(response.tasks)) {
    throw new Error('Live owner returned invalid headless.run response: missing tasks array');
  }
  return {
    workflowId: response.workflowId,
    tasks: response.tasks,
    ownerId: typeof response.ownerId === 'string' ? response.ownerId : undefined,
  };
}

async function submitPlanToLiveOwner(
  planPath: string,
  bus: MessageBus,
  owner: LiveOwnerInfo,
  timeoutMs = 5_000,
): Promise<LiveSubmissionResult> {
  const absolutePlanPath = resolve(planPath);
  const raw = await withTimeout(
    bus.request('headless.run', {
      planPath: absolutePlanPath,
      traceId: createTraceId('invoker-cli.headless.run'),
    }),
    timeoutMs,
  );
  return {
    ...validateLiveSubmissionResponse(raw),
    ownerId: owner.ownerId,
  };
}

function loadRuntimeConfig(configPath?: string): CliRuntimeConfig {
  if (!configPath) return {};
  const resolvedPath = resolve(configPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Config file does not exist: ${resolvedPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid Invoker config JSON at ${resolvedPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid Invoker config at ${resolvedPath}: expected a JSON object`);
  }
  return parsed as CliRuntimeConfig;
}

function isTerminalTaskStatus(status: TaskState['status']): boolean {
  return status === 'completed'
    || status === 'failed'
    || status === 'closed'
    || status === 'needs_input'
    || status === 'review_ready'
    || status === 'awaiting_approval'
    || status === 'stale';
}

function resolvePlanLocalPath(value: string | undefined, cwd: string): string | undefined {
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return resolve(cwd, value);
}

function normalizePlanRuntimePaths(plan: PlanDefinition, cwd: string): PlanDefinition {
  return {
    ...plan,
    repoUrl: resolvePlanLocalPath(plan.repoUrl, cwd) ?? plan.repoUrl,
    intermediateRepoUrl: resolvePlanLocalPath(plan.intermediateRepoUrl, cwd),
  };
}

async function waitForWorkflowToSettle(
  orchestrator: Orchestrator,
  workflowId: string,
  timeoutMs = 24 * 60 * 60 * 1000,
): Promise<TaskState[]> {
  const startedAt = Date.now();
  while (true) {
    const tasks = orchestrator.getAllTasks().filter((task) => task.config.workflowId === workflowId);
    if (tasks.length > 0 && tasks.every((task) => isTerminalTaskStatus(task.status))) {
      return tasks;
    }
    if (
      tasks.some((task) => task.status === 'failed')
      && tasks.every((task) => task.status !== 'running' && task.status !== 'fixing_with_ai')
    ) {
      return tasks;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for standalone workflow ${workflowId} to settle`);
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
  }
}

async function runPlan(planPath: string, options: CliOptions): Promise<RunResult> {
  const absolutePlanPath = resolve(planPath);
  const dbDir = resolve(options.dbDir ?? join(homedir(), '.invoker-cli'));
  mkdirSync(dbDir, { recursive: true });

  const previousInvokerDbDir = process.env.INVOKER_DB_DIR;
  if (options.config) {
    process.env.INVOKER_CONFIG = resolve(options.config);
    process.env.INVOKER_REPO_CONFIG_PATH = resolve(options.config);
  }
  process.env.INVOKER_DB_DIR = dbDir;
  const runtimeConfig = loadRuntimeConfig(options.config);
  const maxConcurrency = runtimeConfig.maxConcurrency ?? 1;

  const persistence = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), {
    ownerCapability: true,
    outputDir: join(dbDir, 'outputs'),
  });
  const stdoutWrite = process.stdout.write;
  if (options.json) {
    process.stdout.write = (() => true) as typeof process.stdout.write;
  }


  try {
    const executionAgentRegistry = registerBuiltinAgents();
    const executorRegistry = new ExecutorRegistry();
    executorRegistry.register('worktree', new WorktreeExecutor({
      worktreeBaseDir: join(dbDir, 'worktrees'),
      cacheDir: join(dbDir, 'repos'),
      maxWorktrees: maxConcurrency,
      agentRegistry: executionAgentRegistry,
    }));
    const orchestrator = new Orchestrator({
      persistence,
      taskRepository: new SqliteTaskRepository(persistence),
      messageBus: noopBus,
      logger: silentLogger,
      maxConcurrency,
      executorRoutingRules: runtimeConfig.executorRoutingRules ?? [],
      defaultPoolId: runtimeConfig.defaultPoolId,
      availablePoolIds: Object.keys(runtimeConfig.executionPools ?? {}),
    });
    const taskRunner = new TaskRunner({
      orchestrator,
      persistence,
      executorRegistry,
      cwd: dirname(absolutePlanPath),
      defaultBranch: runtimeConfig.defaultBranch,
      dockerConfig: {
        imageName: runtimeConfig.docker?.imageName,
        secretsFile: runtimeConfig.docker?.secretsFile,
      },
      remoteTargetsProvider: () => loadRuntimeConfig(options.config).remoteTargets ?? {},
      executionPoolsProvider: () => loadRuntimeConfig(options.config).executionPools ?? {},
      executionAgentRegistry,
      callbacks: {
        onOutput: (taskId, data) => {
          if (!options.json) process.stdout.write(data);
          try {
            persistence.appendTaskOutput(taskId, data);
          } catch {
            // Output is best effort for standalone CLI summaries.
          }
        },
      },
      logger: silentLogger,
    });
    const plan = normalizePlanRuntimePaths(await parsePlanFile(absolutePlanPath), process.cwd());
    orchestrator.loadPlan(plan);
    const started = orchestrator.startExecution();
    await taskRunner.executeTasks(started);

    const workflow = persistence.listWorkflows()[0];
    const tasks = workflow ? await waitForWorkflowToSettle(orchestrator, workflow.id) : [];
    const failedTasks = tasks.filter((task) => task.status === 'failed').length;
    const completedTasks = tasks.filter((task) => task.status === 'completed').length;
    return {
      workflowId: workflow?.id ?? 'unknown',
      status: failedTasks === 0 ? 'success' : 'failed',
      completedTasks,
      failedTasks,
      mode: 'standalone',
    };
  } finally {
    if (options.json) {
      process.stdout.write = stdoutWrite;
    }
    if (previousInvokerDbDir === undefined) {
      delete process.env.INVOKER_DB_DIR;
    } else {
      process.env.INVOKER_DB_DIR = previousInvokerDbDir;
    }
    persistence.close();
  }
}

function printRunResult(result: RunResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ workflow: { id: result.workflowId, status: result.status }, result })}\n`);
  } else if (result.mode === 'live') {
    process.stdout.write(`Delegated to live owner - workflow: ${result.workflowId}\n`);
  }
}

async function createDefaultMessageBus(): Promise<MessageBus> {
  const bus = new IpcBus(undefined, { allowServe: false });
  await bus.ready();
  return bus;
}

/**
 * Read the auto-fix policy knobs from the shared Invoker config so the CLI door
 * drives the engine with the same retry budget / agent the GUI owner uses.
 */
function readAutoFixWorkerConfig(homeRoot: string): { autoFixRetries?: number; autoFixAgent?: string } {
  const configPath = join(homeRoot, 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    return {
      autoFixRetries: typeof parsed.autoFixRetries === 'number' ? parsed.autoFixRetries : undefined,
      autoFixAgent: typeof parsed.autoFixAgent === 'string' ? parsed.autoFixAgent : undefined,
    };
  } catch {
    return {};
  }
}

function workerDisplayName(kind: string): string {
  return kind === AUTO_FIX_WORKER_KIND ? 'Auto-fix' : kind;
}

function printWorkerKinds(): void {
  const registry = registerAutoFixWorker(createWorkerRegistry());
  process.stdout.write('Worker kinds\n');
  for (const worker of registry.list()) {
    process.stdout.write(`  ${worker.kind} — available (${worker.note})\n`);
  }
}

/**
 * Run a registry-selected worker in the foreground. There is exactly one
 * auto-fix engine: the built-in registry entry builds the shared
 * `createRecoveryWorker` from `@invoker/execution-engine` instead of a private
 * poll loop, so the two doors can never run competing scans. The CLI owns the
 * foreground lifetime — owner discovery, connect message, the SIGINT/SIGTERM
 * block, and a deterministic stop.
 */
async function runWorker(definition: WorkerDefinition, bus: MessageBus): Promise<number> {
  const owner = await discoverLiveOwner(bus);
  const homeRoot = resolveInvokerHomeRoot();
  const { autoFixRetries, autoFixAgent } = readAutoFixWorkerConfig(homeRoot);

  // Single-instance guard: refuse if another worker of this kind (this door or
  // the dev `--headless worker <kind>` door) already holds the cross-process
  // lock, rather than spawning a second recovery loop that competes over the
  // same failed tasks.
  let lock;
  try {
    lock = acquireWorkerLock({ kind: definition.kind, homeRoot, logger: silentLogger });
  } catch (err) {
    if (err instanceof WorkerLockHeldError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  const persistence = await SQLiteAdapter.create(join(homeRoot, 'invoker.db'), {
    outputDir: join(homeRoot, 'outputs'),
  });

  // Open the try before constructing/starting the worker so persistence is
  // always closed even if construction or start throws (otherwise the SQLite
  // handle leaks when control unwinds to main()'s catch).
  try {
    const worker = definition.factory({
      logger: silentLogger,
      messageBus: bus,
      store: persistence,
      submitter: {
        submit: (workflowId, priority, channel, mutationArgs) =>
          persistence.enqueueWorkflowMutationIntent(workflowId, channel, mutationArgs, priority),
      },
      autoFix: {
        defaultAutoFixRetries: autoFixRetries,
        getAutoFixAgent: () => autoFixAgent,
      },
    });

    worker.start();
    const ownerSuffix = owner?.ownerId ? ` to owner ${owner.ownerId}` : '';
    process.stdout.write(`${workerDisplayName(definition.kind)} worker connected${ownerSuffix}.\n`);

    await new Promise<void>((resolveShutdown) => {
      const shutdown = (): void => resolveShutdown();
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
    await worker.stop();
  } finally {
    // Release deterministically so a clean shutdown never leaves a stale lock
    // that blocks the next legitimate start.
    lock.release();
    persistence.close();
  }
  process.stdout.write(`${workerDisplayName(definition.kind)} worker stopped.\n`);
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2), deps: CliDeps = {}): Promise<number> {
  let bus: MessageBus | undefined;
  try {
    if (argv[0] === 'doctor') {
      return runDoctor(argv.slice(1));
    }
    if (argv[0] === 'setup') {
      return await runSetup(argv.slice(1));
    }
    if (argv[0] === 'mcp') {
      await (deps.runMcpServer ?? runMcpServer)();
      return 0;
    }
    if (argv[0] === 'worker') {
      const subcommand = argv[1] ?? 'list';
      const registry = registerAutoFixWorker(createWorkerRegistry());
      if (subcommand === 'list') {
        printWorkerKinds();
        return 0;
      }
      const definition = registry.get(subcommand);
      if (!definition) {
        const knownKinds = registry.list().map((worker) => worker.kind).join(', ');
        throw new Error(`Unknown worker kind: "${subcommand}". Usage: invoker-cli worker <${knownKinds}|list>`);
      }
      bus = await (deps.createMessageBus?.() ?? createDefaultMessageBus());
      return await runWorker(definition, bus);
    }
    const parsed = parseArgs(argv);
    if (!parsed.command || parsed.command === '--help') {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (parsed.command === '--version') {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (parsed.command !== 'run') {
      throw new Error(`Unknown command: ${parsed.command}`);
    }
    if (!parsed.planPath) {
      throw new Error('Missing plan file. Usage: invoker-cli run <plan.yaml>');
    }

    if (parsed.options.mode === 'live' && parsed.options.dbDir) {
      throw new Error('--db-dir cannot be used with --live because the UI owner database is authoritative');
    }

    if (parsed.options.mode !== 'standalone') {
      bus = await (deps.createMessageBus?.() ?? createDefaultMessageBus());
      const owner = await discoverLiveOwner(bus);
      if (owner) {
        if (parsed.options.dbDir) {
          throw new Error('--db-dir cannot be used when a live UI owner accepts the run; use --standalone to force an isolated database');
        }
        const submitted = await submitPlanToLiveOwner(parsed.planPath, bus, owner);
        printRunResult({
          workflowId: submitted.workflowId,
          status: 'success',
          completedTasks: 0,
          failedTasks: 0,
          mode: 'live',
        }, parsed.options.json);
        return 0;
      }
      if (parsed.options.mode === 'live') {
        throw new Error('No running Invoker UI owner is reachable; start the UI or omit --live to run standalone');
      }
    }

    const result = await runPlan(parsed.planPath, parsed.options);
    printRunResult(result, parsed.options.json);
    return result.status === 'success' ? 0 : 1;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    const disconnect = (bus as { disconnect?: () => void } | undefined)?.disconnect;
    if (disconnect) {
      disconnect.call(bus);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
