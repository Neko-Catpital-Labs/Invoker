import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Logger } from '@invoker/contracts';
import { SQLiteAdapter, SqliteTaskRepository } from '@invoker/data-store';
import {
  ExecutorRegistry,
  TaskRunner,
  WorktreeExecutor,
  registerBuiltinAgents,
  remoteFetchForPool,
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

const VERSION = '0.0.5';

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

type WorkerStartResult = {
  ok: true;
};

type WorkerStatusResult = {
  workers: Array<Record<string, unknown>>;
};

type CliDeps = {
  createMessageBus?: () => Promise<MessageBus> | MessageBus;
};

type DoctorCheck = {
  name: string;
  command: string;
  requiredFor: string;
  install?: {
    brew?: string[];
    apt?: string[];
    npm?: string[];
  };
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

const doctorChecks: DoctorCheck[] = [
  { name: 'git', command: 'git', requiredFor: 'repository checkout, branches, and merges', install: { brew: ['git'], apt: ['git'] } },
  { name: 'pnpm', command: 'pnpm', requiredFor: 'workspace dependency installs and local builds', install: { brew: ['pnpm'], npm: ['pnpm'] } },
  { name: 'gh', command: 'gh', requiredFor: 'GitHub PR and release workflows', install: { brew: ['gh'], apt: ['gh'] } },
  { name: 'Docker', command: 'docker', requiredFor: 'container executors', install: { brew: ['docker'], apt: ['docker.io'] } },
  { name: 'Codex CLI', command: 'codex', requiredFor: 'Codex-backed task execution', install: { npm: ['@openai/codex'] } },
  { name: 'Claude CLI', command: 'claude', requiredFor: 'Claude-backed task execution', install: { npm: ['@anthropic-ai/claude-code'] } },
  { name: 'ssh', command: 'ssh', requiredFor: 'remote SSH executors', install: { apt: ['openssh-client'] } },
];

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
    '  invoker-cli worker autofix',
    '  invoker-cli worker [list|status]',
    '  invoker-cli doctor [--fix] [--json]',
    '  invoker-cli --help',
    '  invoker-cli --version',
    '',
    'Commands:',
    '  run <plan.yaml>  Submit to a live Invoker UI when available, otherwise run standalone.',
    '  worker autofix  Start the long-running auto-fix recovery worker on the Invoker owner.',
    '  worker list     List explicit long-running worker services.',
    '  doctor          Check external runtime tools used by Invoker executors.',
    '',
    'Options:',
    '  --live           Require a running Invoker UI owner and submit over IPC.',
    '  --standalone     Skip IPC and run with an isolated CLI database.',
    '  --db-dir <path>  Runtime database directory. Defaults to ~/.invoker-cli',
    '  --config <path>  Optional config path reserved for CLI runtime configuration.',
    '  --json           Emit a machine-readable result summary.',
    '  --fix            Best-effort install of missing doctor tools.',
    '  --help           Show this help text.',
    '  --version        Show the CLI version.',
  ].join('\n');
}

function commandExists(command: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${command} >/dev/null 2>&1`], {
    stdio: 'ignore',
  }).status === 0;
}

function runInstall(command: string, args: string[]): number {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  return result.status ?? 1;
}

function installDoctorTool(check: DoctorCheck): { attempted: boolean; ok: boolean; detail: string } {
  if (process.platform === 'darwin' && commandExists('brew') && check.install?.brew?.length) {
    const code = runInstall('brew', ['install', ...check.install.brew]);
    return { attempted: true, ok: code === 0, detail: `brew install ${check.install.brew.join(' ')}` };
  }
  if (process.platform === 'linux' && commandExists('apt-get') && check.install?.apt?.length) {
    const runner = typeof process.getuid === 'function' && process.getuid() === 0 ? 'apt-get' : commandExists('sudo') ? 'sudo' : '';
    if (runner) {
      const args = runner === 'sudo'
        ? ['apt-get', 'install', '-y', ...check.install.apt]
        : ['install', '-y', ...check.install.apt];
      const code = runInstall(runner, args);
      return { attempted: true, ok: code === 0, detail: `${runner} ${args.join(' ')}` };
    }
  }
  if (commandExists('npm') && check.install?.npm?.length) {
    const code = runInstall('npm', ['install', '-g', ...check.install.npm]);
    return { attempted: true, ok: code === 0, detail: `npm install -g ${check.install.npm.join(' ')}` };
  }
  return { attempted: false, ok: false, detail: 'No supported installer available' };
}

function parseDoctorArgs(argv: string[]): { fix: boolean; json: boolean } {
  const options = { fix: false, json: false };
  for (const arg of argv) {
    if (arg === '--fix') options.fix = true;
    else if (arg === '--json') options.json = true;
    else throw new Error(`Unknown doctor option: ${arg}`);
  }
  return options;
}

function runDoctor(argv: string[]): number {
  const options = parseDoctorArgs(argv);
  const results = doctorChecks.map((check) => {
    let available = commandExists(check.command);
    let fix: ReturnType<typeof installDoctorTool> | undefined;
    if (!available && options.fix) {
      fix = installDoctorTool(check);
      available = commandExists(check.command);
    }
    return {
      name: check.name,
      command: check.command,
      requiredFor: check.requiredFor,
      available,
      fix,
    };
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: results.every((result) => result.available), checks: results })}\n`);
  } else {
    for (const result of results) {
      const status = result.available ? 'ok' : 'missing';
      const fix = result.fix ? ` (${result.fix.detail}: ${result.fix.ok ? 'ok' : 'failed'})` : '';
      process.stdout.write(`${status.padEnd(7)} ${result.command.padEnd(8)} ${result.requiredFor}${fix}\n`);
    }
    const missing = results.filter((result) => !result.available);
    if (missing.length > 0) {
      process.stdout.write('\nAuthentication-dependent setup, such as gh auth login and provider CLI login, remains manual.\n');
    }
  }

  return results.every((result) => result.available) ? 0 : 1;
}

function parseArgs(argv: string[]): { command?: string; planPath?: string; workerSubcommand?: string; options: CliOptions } {
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
    workerSubcommand: positional[1],
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

async function discoverSharedOwner(bus: MessageBus, timeoutMs = 1_000): Promise<LiveOwnerInfo | null> {
  try {
    const raw = await withTimeout(
      bus.request('headless.owner-ping', {}),
      timeoutMs,
    );
    if (!raw || typeof raw !== 'object') return null;
    const response = raw as Record<string, unknown>;
    if (response.mode !== 'gui' && response.mode !== 'standalone') return null;
    return {
      ownerId: typeof response.ownerId === 'string' ? response.ownerId : '',
      mode: String(response.mode),
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

function validateWorkerStartResponse(raw: unknown): WorkerStartResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Live owner returned invalid headless.exec response: expected object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const response = raw as Record<string, unknown>;
  if (response.ok !== true) {
    throw new Error('Live owner returned invalid headless.exec response: missing ok=true');
  }
  return { ok: true };
}

async function startWorkerOnLiveOwner(
  subcommand: string,
  bus: MessageBus,
  timeoutMs = 5_000,
): Promise<WorkerStartResult> {
  const raw = await withTimeout(
    bus.request('headless.exec', {
      args: ['worker', subcommand],
      traceId: createTraceId('invoker-cli.headless.exec.worker'),
    }),
    timeoutMs,
  );
  return validateWorkerStartResponse(raw);
}

function validateWorkerStatusResponse(raw: unknown): WorkerStatusResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Live owner returned invalid worker status response: expected object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const response = raw as Record<string, unknown>;
  if (!Array.isArray(response.workers)) {
    throw new Error('Live owner returned invalid worker status response: missing workers array');
  }
  return { workers: response.workers.filter((worker): worker is Record<string, unknown> => Boolean(worker) && typeof worker === 'object' && !Array.isArray(worker)) };
}

async function queryWorkerStatusFromLiveOwner(
  bus: MessageBus,
  timeoutMs = 5_000,
): Promise<WorkerStatusResult> {
  const raw = await withTimeout(
    bus.request('headless.query', {
      kind: 'worker-status',
      traceId: createTraceId('invoker-cli.headless.query.worker-status'),
    }),
    timeoutMs,
  );
  return validateWorkerStatusResponse(raw);
}

function renderOptional(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function renderWorkerStatus(result: WorkerStatusResult, owner?: LiveOwnerInfo): string {
  const lines = ['Worker services:'];
  if (!owner) {
    lines.push('  autofix  service=unknown owner=- (no reachable shared owner)');
    return lines.join('\n');
  }
  for (const worker of result.workers) {
    const kind = renderOptional(worker.kind);
    const service = renderOptional(worker.service);
    const workerOwner = renderOptional(worker.owner);
    const note = renderOptional(worker.note);
    lines.push(`  ${kind}  service=${service} owner=${workerOwner} (${note})`);
    const snapshot = readRecord(worker.snapshot);
    const recovery = readRecord(snapshot?.recovery);
    if (!recovery) continue;
    lines.push(
      `    lastScan=${renderOptional(recovery.lastScanAt)} reason=${renderOptional(recovery.lastScanReason)} source=${renderOptional(recovery.lastScanSource)} candidates=${renderOptional(recovery.lastScanCandidateCount)}`,
    );
    lines.push(
      `    wakeups=${renderOptional(recovery.wakeupCount)} lastWakeup=${renderOptional(recovery.lastWakeupAt)} task=${renderOptional(recovery.lastWakeupTaskId)}`,
    );
    lines.push(
      `    submissions=${renderOptional(recovery.submittedCount)} lastSubmit=${renderOptional(recovery.lastSubmittedAt)} task=${renderOptional(recovery.lastSubmittedTaskId)} intent=${renderOptional(recovery.lastSubmittedIntentId)}`,
    );
    lines.push(
      `    skips=${renderOptional(recovery.skippedCount)} lastSkip=${renderOptional(recovery.lastSkipReason)} task=${renderOptional(recovery.lastSkipTaskId)} at=${renderOptional(recovery.lastSkipAt)}`,
    );
    const skipReasons = readRecord(recovery.skipReasons);
    const renderedSkipReasons = skipReasons
      ? Object.entries(skipReasons).map(([reason, count]) => `${reason}=${String(count)}`).join(' ')
      : '';
    lines.push(`    skipReasons=${renderedSkipReasons || '-'}; audit=query audit <taskId>`);
  }
  return lines.join('\n');
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
  options: { includeMergeNodes?: boolean } = {},
): Promise<TaskState[]> {
  const startedAt = Date.now();
  while (true) {
    const tasks = orchestrator.getAllTasks().filter((task) =>
      task.config.workflowId === workflowId
      && (options.includeMergeNodes !== false || !task.config.isMergeNode),
    );
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
  const previousRemoteFetchForPool = remoteFetchForPool.enabled;
  if (options.config) {
    process.env.INVOKER_CONFIG = resolve(options.config);
    process.env.INVOKER_REPO_CONFIG_PATH = resolve(options.config);
  }
  process.env.INVOKER_DB_DIR = dbDir;
  remoteFetchForPool.enabled = false;
  const runtimeConfig = loadRuntimeConfig(options.config);
  const maxConcurrency = runtimeConfig.maxConcurrency ?? 1;

  const persistence = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), {
    ownerCapability: true,
    outputDir: join(dbDir, 'outputs'),
  });

  try {
    const executionAgentRegistry = registerBuiltinAgents();
    const executorRegistry = new ExecutorRegistry();
    executorRegistry.register('worktree', new WorktreeExecutor({
      worktreeBaseDir: join(dbDir, 'worktrees'),
      cacheDir: join(dbDir, 'repos'),
      maxWorktrees: maxConcurrency,
      agentRegistry: executionAgentRegistry,
      provisionCommand: 'true',
      publishTaskResults: false,
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
    const plan = normalizePlanRuntimePaths(await parsePlanFile(absolutePlanPath), process.cwd());
    const executeMergeNodes = plan.onFinish !== 'none';
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
      executeMergeNodes,
      callbacks: {
        onOutput: (taskId, data) => {
          process.stdout.write(data);
          try {
            persistence.appendTaskOutput(taskId, data);
          } catch {
            // Output is best effort for standalone CLI summaries.
          }
        },
      },
      logger: silentLogger,
    });
    orchestrator.loadPlan(plan);
    const started = orchestrator.startExecution();
    await taskRunner.executeTasks(started);

    const workflow = persistence.listWorkflows()[0];
    const tasks = workflow ? await waitForWorkflowToSettle(orchestrator, workflow.id, undefined, { includeMergeNodes: executeMergeNodes }) : [];
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
    if (previousInvokerDbDir === undefined) {
      delete process.env.INVOKER_DB_DIR;
    } else {
      process.env.INVOKER_DB_DIR = previousInvokerDbDir;
    }
    remoteFetchForPool.enabled = previousRemoteFetchForPool;
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

export async function main(argv: string[] = process.argv.slice(2), deps: CliDeps = {}): Promise<number> {
  let bus: MessageBus | undefined;
  try {
    if (argv[0] === 'doctor') {
      return runDoctor(argv.slice(1));
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
    if (parsed.command === 'worker') {
      const subcommand = parsed.workerSubcommand;
      if (!subcommand || subcommand === 'list') {
        process.stdout.write('Worker services:\n  autofix  long-running auto-fix recovery worker\n');
        return 0;
      }
      if (subcommand === 'status') {
        bus = await (deps.createMessageBus?.() ?? createDefaultMessageBus());
        const owner = await discoverSharedOwner(bus);
        const status = owner ? await queryWorkerStatusFromLiveOwner(bus) : { workers: [] };
        if (parsed.options.json) {
          process.stdout.write(`${JSON.stringify({ ownerId: owner?.ownerId ?? null, ...status })}\n`);
        } else {
          process.stdout.write(`${renderWorkerStatus(status, owner ?? undefined)}\n`);
        }
        return 0;
      }
      if (subcommand !== 'autofix') {
        throw new Error(`Unknown worker sub-command: ${subcommand}. Usage: invoker-cli worker autofix`);
      }
      if (parsed.options.mode === 'standalone') {
        throw new Error('worker autofix requires a shared Invoker owner; --standalone is not supported');
      }
      if (parsed.options.dbDir) {
        throw new Error('--db-dir cannot be used with worker autofix because the owner database is authoritative');
      }
      bus = await (deps.createMessageBus?.() ?? createDefaultMessageBus());
      const owner = await discoverSharedOwner(bus);
      if (!owner) {
        throw new Error('No running Invoker owner is reachable; start the UI or standalone owner before starting worker autofix');
      }
      await startWorkerOnLiveOwner(subcommand, bus);
      if (parsed.options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, worker: subcommand, ownerId: owner.ownerId })}\n`);
      } else {
        process.stdout.write(`Started ${subcommand} worker on shared owner ${owner.ownerId}\n`);
      }
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
