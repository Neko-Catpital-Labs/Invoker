import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_DRAFTER_MCP_PACKAGE_SPEC,
  readInvokerConfigFile,
  resolveHeadlessOwnerLaunchSpec,
  resolveInvokerHomeRoot,
  resolveRepoRoot,
  updateInvokerConfigFile,
  type HeadlessOwnerLaunchSpec,
  type Logger,
} from '@invoker/contracts';
import { SQLiteAdapter, SqliteTaskRepository, type Workflow } from '@invoker/data-store';
import {
  AUTO_FIX_WORKER_KIND,
  ExecutorRegistry,
  TaskRunner,
  WorktreeExecutor,
  acquireWorkerLock,
  createAutoFixAttemptLedger,
  createWorkerRegistry,
  registerAutoFixWorker,
  registerExternalWorkers,
  WorkerLockHeldError,
  registerBuiltinAgents,
  type ExternalWorkerConfig,
  type ExternalWorkerRuntime,
  type WorkerDefinition,
  type WorkerRegistry,
  type WorkerRuntime,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';
import { type MessageBus } from '@invoker/transport';
import {
  Orchestrator,
  parsePlanFile,
  type OrchestratorMessageBus,
  type PlanDefinition,
  type TaskState,
} from '@invoker/workflow-core';
import { logCaughtException } from './logging.js';
import {
  createDefaultMessageBus,
  createTraceId,
  discoverLiveOwner,
  withTimeout,
  type LiveOwnerInfo,
} from './live-owner-bus.js';
import { runMcpServer } from './mcp-server.js';
import { defaultConfigPath, runDoctor, runSetup } from './onboarding.js';
import {
  applyWorkerToggle,
  findWorkerToggle,
  ONBOARDING_WORKER_TOGGLES,
  readWorkerToggleValue,
} from './worker-toggles.js';

const VERSION = '0.0.11';

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

type LiveSubmissionResult = {
  workflowId: string;
  tasks: unknown[];
  ownerId?: string;
};

type CliDeps = {
  createMessageBus?: () => Promise<MessageBus> | MessageBus;
  runMcpServer?: () => Promise<void>;
  resolveOwnerLaunchSpec?: (repoRoot: string) => HeadlessOwnerLaunchSpec;
  spawnProcess?: typeof spawn;
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
    maxConcurrentTasks?: number;
  }>;
  worktreeTargets?: Record<string, {
    provisionCommand?: string;
    maxConcurrentTasks?: number;
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
  autoFixRetries?: number;
  autoFixAgent?: string;
  autoFixExecutionModel?: string;
  autoApproveAIFixes?: boolean;
  externalWorkers?: ExternalWorkerConfig[];
};

type QueryResource = 'workflows' | 'tasks';
type QueryOutput = 'text' | 'json';

type QueryOptions = {
  resource: QueryResource;
  workflowId?: string;
  status?: string;
  output: QueryOutput;
  forwardedFlags: string[];
};

type RetryTasksOptions = {
  status: string;
  parallel: number;
  dryRun: boolean;
};

type RetryTaskRow = {
  id: string;
  status?: string;
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
    '  invoker-cli query workflows [--status <status>] [--output text|json]',
    '  invoker-cli query tasks [--workflow <id>] [--status <status>] [--output text|json]',
    '  invoker-cli retry-task <taskId>',
    '  invoker-cli retry <workflowId>',
    '  invoker-cli resume <workflowId>',
    '  invoker-cli retry-tasks --status <status> [--parallel N] [--dry-run]',
    '  invoker-cli delete-all',
    '  invoker-cli owner serve',
    '  invoker-cli doctor [--fix] [--json]',
    '  invoker-cli setup [planner|slack] [--check|--from-env] [--yes] [--json]',
    '  invoker-cli mcp',
    '  invoker-cli worker [autofix|list]',
    '  invoker-cli worker toggles [--enable <id>|--disable <id> ...]',
    '  invoker-cli --help',
    '  invoker-cli --version',
    '',
    'Commands:',
    '  run <plan.yaml>  Submit to a live Invoker owner when available, otherwise run standalone.',
    '  query workflows|tasks  Read workflows or tasks from a live owner, or a read-only database view.',
    '  retry-task <taskId>  Ask a live Invoker owner to retry one task.',
    '  retry <workflowId>  Ask a live Invoker owner to retry a workflow.',
    '  resume <workflowId> Ask a live Invoker owner to resume a workflow.',
    '  retry-tasks --status <status>  Retry all tasks matching a status through a live owner.',
    '  delete-all      Ask a live Invoker owner to delete all workflows, after the production DB guard passes.',
    '  owner serve     Start a headless Invoker owner process.',
    '  doctor          Validate tools, config, and your default planning preset.',
    '  setup [planner|slack]  Run the setup wizard, or directly configure planner MCP or Slack.',
    '  mcp             Start the Invoker MCP stdio server.',
    '  worker [kind|list]  Run a registry-selected worker or list available worker kinds.',
    '  worker toggles      Show or set the on/off state of optional owner workers (PR maintenance, e2e auto-fix, auto-approve, disk-headroom cleanup).',
    '',
    'Options:',
    '  --planner-url <url>   Planner service URL for `setup planner`.',
    '  --access-token <tok>  Planner service access token for `setup planner`.',
    `  --planner-package <spec>  Planner MCP package spec for \`setup planner\`. Defaults to ${DEFAULT_DRAFTER_MCP_PACKAGE_SPEC}.`,
    '  --target <path>       MCP config path for planner setup. Defaults to ~/.invoker/mcp.json.',
    '  --uninstall           Remove the experimental planner MCP entry and disable its Invoker flag.',
    '  --live           Require a running Invoker owner and submit over IPC.',
    '  --standalone     Skip IPC and run with an isolated CLI database.',
    '  --db-dir <path>  Runtime database directory. Defaults to ~/.invoker-cli',
    '  --config <path>  Optional config path reserved for CLI runtime configuration.',
    '  --json           Emit only a machine-readable result summary on stdout.',
    '  --workflow <id>  Restrict `query tasks` to one workflow.',
    '  --status <status>  Restrict `query workflows` or `query tasks` to one status.',
    '  --parallel N    Maximum concurrent mutation requests for `retry-tasks`. Defaults to 8.',
    '  --dry-run       Print matching task IDs for `retry-tasks` without mutating.',
    '  --output <fmt>   Query output format. Supported values: text, json. Defaults to text.',
    '  --from-env       Run Slack setup from SLACK_* environment values without prompts.',
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

function parseQueryArgs(argv: string[]): QueryOptions {
  const resource = argv[0];
  if (resource !== 'workflows' && resource !== 'tasks') {
    throw new Error('Missing or unknown query subcommand. Usage: invoker-cli query <workflows|tasks>');
  }

  const options: QueryOptions = {
    resource,
    output: 'text',
    forwardedFlags: [],
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workflow') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --workflow');
      if (resource !== 'tasks') throw new Error('--workflow is only supported for `query tasks`');
      options.workflowId = value;
      options.forwardedFlags.push(arg, value);
    } else if (arg === '--status') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --status');
      options.status = value;
      options.forwardedFlags.push(arg, value);
    } else if (arg === '--output') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --output');
      if (value !== 'text' && value !== 'json') {
        throw new Error('Invalid --output value. Supported values: text, json');
      }
      options.output = value;
      options.forwardedFlags.push(arg, value);
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('Usage: invoker-cli query <workflows|tasks> [--workflow <id>] [--status <status>] [--output text|json]');
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown query option: ${arg}`);
    } else {
      throw new Error(`Unexpected query argument: ${arg}`);
    }
  }

  return options;
}

function parseRetryTasksArgs(argv: string[]): RetryTasksOptions {
  const options: Partial<RetryTasksOptions> = {
    parallel: 8,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--status') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --status');
      options.status = value;
    } else if (arg === '--parallel') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --parallel');
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== value) {
        throw new Error('Invalid --parallel value. Expected a positive integer.');
      }
      options.parallel = parsed;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('Usage: invoker-cli retry-tasks --status <status> [--parallel N] [--dry-run]');
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown retry-tasks option: ${arg}`);
    } else {
      throw new Error(`Unexpected retry-tasks argument: ${arg}`);
    }
  }

  if (!options.status) {
    throw new Error('Missing --status. Usage: invoker-cli retry-tasks --status <status> [--parallel N] [--dry-run]');
  }

  return options as RetryTasksOptions;
}

function validateLiveQueryResponse(raw: unknown): string {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Live owner returned invalid headless.query response: expected object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const output = (raw as Record<string, unknown>).output;
  if (typeof output !== 'string') {
    throw new Error('Live owner returned invalid headless.query response: missing output string');
  }
  return output;
}

async function queryLiveOwner(
  options: QueryOptions,
  bus: MessageBus,
): Promise<string> {
  const raw = await withTimeout(
    bus.request('headless.query', {
      kind: 'cli-query',
      args: ['query', options.resource, ...options.forwardedFlags],
    }),
    15_000,
  );
  return validateLiveQueryResponse(raw);
}

function resolveQueryDbDir(): string {
  return resolve(process.env.INVOKER_DB_DIR ?? join(homedir(), '.invoker'));
}

function expandHomePath(raw: string): string {
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return raw;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function normalizeDeleteAllGuardPath(raw: string): string {
  let expanded = expandHomePath(raw);
  expanded = expanded.endsWith('/') ? expanded.slice(0, -1) : expanded;
  if (expanded.length === 0) expanded = '/';

  if (isDirectory(expanded)) {
    return realpathSync(expanded);
  }

  const parent = dirname(expanded);
  if (isDirectory(parent)) {
    return join(realpathSync(parent), basename(expanded));
  }

  return expanded;
}

function checkDeleteAllProductionGuard(): number | undefined {
  const dbRoot = normalizeDeleteAllGuardPath(process.env.INVOKER_DB_DIR ?? join(homedir(), '.invoker'));
  const prodRoot = normalizeDeleteAllGuardPath(join(homedir(), '.invoker'));
  if (process.env.INVOKER_ALLOW_PRODUCTION_DELETE_ALL !== '1' && dbRoot === prodRoot) {
    process.stderr.write(`ERROR: Refusing to run 'delete-all' against production DB root: ${dbRoot}\n`);
    process.stderr.write('Set INVOKER_DB_DIR to an isolated temp directory for tests.\n');
    process.stderr.write('Override only if intentional: INVOKER_ALLOW_PRODUCTION_DELETE_ALL=1\n');
    return 64;
  }
  return undefined;
}

function serializeWorkflowForQuery(workflow: Workflow): Record<string, unknown> {
  return {
    id: workflow.id,
    name: workflow.name,
    status: workflow.status,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    ...(workflow.description != null ? { description: workflow.description } : {}),
    ...(workflow.visualProof != null ? { visualProof: workflow.visualProof } : {}),
    ...(workflow.planFile != null ? { planFile: workflow.planFile } : {}),
    ...(workflow.repoUrl != null ? { repoUrl: workflow.repoUrl } : {}),
    ...(workflow.intermediateRepoUrl != null ? { intermediateRepoUrl: workflow.intermediateRepoUrl } : {}),
    ...(workflow.branch != null ? { branch: workflow.branch } : {}),
    ...(workflow.onFinish != null ? { onFinish: workflow.onFinish } : {}),
    ...(workflow.baseBranch != null ? { baseBranch: workflow.baseBranch } : {}),
    ...(workflow.featureBranch != null ? { featureBranch: workflow.featureBranch } : {}),
    ...(workflow.mergeMode != null ? { mergeMode: workflow.mergeMode } : {}),
    ...(workflow.reviewProvider != null ? { reviewProvider: workflow.reviewProvider } : {}),
    ...(workflow.externalDependencies != null ? { externalDependencies: workflow.externalDependencies } : {}),
    ...(workflow.externalDependencyChanges != null ? { externalDependencyChanges: workflow.externalDependencyChanges } : {}),
    ...(workflow.detachedExternalDependencies != null ? { detachedExternalDependencies: workflow.detachedExternalDependencies } : {}),
    ...(workflow.generation != null ? { generation: workflow.generation } : {}),
  };
}

function serializeTaskForQuery(task: TaskState): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (task.config.workflowId != null) config.workflowId = task.config.workflowId;
  if (task.config.command != null) config.command = task.config.command;
  if (task.config.prompt != null) config.prompt = task.config.prompt;
  if (task.config.runnerKind != null) config.runnerKind = task.config.runnerKind;
  if (task.config.poolId != null) config.poolId = task.config.poolId;
  if (task.config.poolMemberId != null) config.poolMemberId = task.config.poolMemberId;
  if (task.config.isMergeNode != null) config.isMergeNode = task.config.isMergeNode;
  if (task.config.executionAgent != null) config.executionAgent = task.config.executionAgent;
  if (task.config.executionModel != null) config.executionModel = task.config.executionModel;
  if (task.config.featureBranch != null) config.featureBranch = task.config.featureBranch;

  const execution: Record<string, unknown> = {};
  if (task.execution.branch != null) execution.branch = task.execution.branch;
  if (task.execution.commit != null) execution.commit = task.execution.commit;
  if (task.execution.error != null) execution.error = task.execution.error;
  if (task.execution.exitCode != null) execution.exitCode = task.execution.exitCode;
  if (task.execution.reviewUrl != null) execution.reviewUrl = task.execution.reviewUrl;
  if (task.execution.reviewId != null) execution.reviewId = task.execution.reviewId;
  if (task.execution.reviewStatus != null) execution.reviewStatus = task.execution.reviewStatus;
  if (task.execution.reviewProviderId != null) execution.reviewProviderId = task.execution.reviewProviderId;
  if (task.execution.agentSessionId != null) execution.agentSessionId = task.execution.agentSessionId;
  if (task.execution.lastAgentSessionId != null) execution.lastAgentSessionId = task.execution.lastAgentSessionId;
  if (task.execution.agentName != null) execution.agentName = task.execution.agentName;
  if (task.execution.lastAgentName != null) execution.lastAgentName = task.execution.lastAgentName;
  if (task.execution.phase != null) execution.phase = task.execution.phase;
  if (task.execution.startedAt != null) execution.startedAt = task.execution.startedAt.toISOString();
  if (task.execution.completedAt != null) execution.completedAt = task.execution.completedAt.toISOString();
  if (task.execution.launchStartedAt != null) execution.launchStartedAt = task.execution.launchStartedAt.toISOString();
  if (task.execution.launchCompletedAt != null) execution.launchCompletedAt = task.execution.launchCompletedAt.toISOString();
  if (task.execution.lastHeartbeatAt != null) execution.lastHeartbeatAt = task.execution.lastHeartbeatAt.toISOString();
  if (task.execution.pendingFixError != null) execution.pendingFixError = task.execution.pendingFixError;

  return {
    id: task.id,
    description: task.description,
    status: task.status,
    dependencies: [...task.dependencies],
    createdAt: task.createdAt.toISOString(),
    config,
    execution,
  };
}

function renderWorkflowText(workflows: Workflow[]): string {
  if (workflows.length === 0) return 'No workflows found.\n';
  return `${workflows.map((workflow) => (
    `${workflow.id}\t${workflow.status}\t${workflow.name}\t${workflow.createdAt}`
  )).join('\n')}\n`;
}

function renderTaskText(tasks: TaskState[]): string {
  if (tasks.length === 0) return 'No tasks found.\n';
  return `${tasks.map((task) => (
    `${task.id}\t${task.config.workflowId ?? ''}\t${task.status}\t${task.description}`
  )).join('\n')}\n`;
}

async function queryStandaloneDatabase(options: QueryOptions): Promise<string> {
  const dbDir = resolveQueryDbDir();
  const dbPath = join(dbDir, 'invoker.db');
  if (!existsSync(dbPath)) {
    return `${options.output === 'json' ? '[]' : (options.resource === 'workflows' ? 'No workflows found.' : 'No tasks found.')}\n`;
  }

  const persistence = await SQLiteAdapter.create(dbPath, {
    readOnly: true,
    outputDir: join(dbDir, 'outputs'),
    slowQueryThresholdMs: 0,
  });
  try {
    const snapshot = persistence.loadWorkflowTaskSnapshot();
    const workflows = snapshot.workflows.filter((workflow) => (
      !options.status || workflow.status === options.status
    ));
    if (options.resource === 'workflows') {
      return options.output === 'json'
        ? `${JSON.stringify(workflows.map(serializeWorkflowForQuery))}\n`
        : renderWorkflowText(workflows);
    }

    let tasks = snapshot.tasks;
    if (options.workflowId) {
      tasks = tasks.filter((task) => task.config.workflowId === options.workflowId);
    }
    if (options.status) {
      tasks = tasks.filter((task) => task.status === options.status);
    }
    return options.output === 'json'
      ? `${JSON.stringify(tasks.map(serializeTaskForQuery))}\n`
      : renderTaskText(tasks);
  } finally {
    persistence.close();
  }
}

async function runQuery(options: QueryOptions, deps: CliDeps): Promise<number> {
  let bus: MessageBus | undefined;
  try {
    bus = await (deps.createMessageBus?.() ?? createDefaultMessageBus());
    const owner = await discoverLiveOwner(bus);
    if (owner) {
      process.stdout.write(await queryLiveOwner(options, bus));
      return 0;
    }
  } finally {
    const disconnect = (bus as { disconnect?: () => void } | undefined)?.disconnect;
    if (disconnect) {
      disconnect.call(bus);
    }
  }

  process.stdout.write(await queryStandaloneDatabase(options));
  return 0;
}

const REQUIRED_OWNER_MESSAGE = 'No running Invoker owner is reachable; start the Invoker app or run `invoker-cli owner serve`.';

function mutationQueryOptions(status: string): QueryOptions {
  return {
    resource: 'tasks',
    status,
    output: 'json',
    forwardedFlags: ['--status', status, '--output', 'json'],
  };
}

function parseRetryTaskRows(output: string, status: string): RetryTaskRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (err) {
    throw new Error(`Could not parse task query JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Task query returned invalid JSON: expected an array');
  }
  return parsed
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item) => item.status === status)
    .filter((item): item is RetryTaskRow => typeof item.id === 'string' && item.id.length > 0);
}

async function queryRetryTasks(status: string, bus?: MessageBus, owner?: LiveOwnerInfo | null): Promise<RetryTaskRow[]> {
  const options = mutationQueryOptions(status);
  const output = owner && bus
    ? await queryLiveOwner(options, bus)
    : await queryStandaloneDatabase(options);
  return parseRetryTaskRows(output, status);
}

async function requireLiveOwnerForMutation(bus: MessageBus): Promise<LiveOwnerInfo> {
  const owner = await discoverLiveOwner(bus);
  if (!owner) {
    throw new Error(REQUIRED_OWNER_MESSAGE);
  }
  return owner;
}

async function sendHeadlessExec(bus: MessageBus, args: string[]): Promise<void> {
  await withTimeout(
    bus.request('headless.exec', { args, noTrack: true }),
    30_000,
  );
}

async function runSimpleMutation(command: 'retry-task' | 'retry' | 'resume', targetId: string | undefined, deps: CliDeps): Promise<number> {
  if (!targetId) {
    const target = command === 'retry-task' ? 'taskId' : 'workflowId';
    throw new Error(`Missing ${target}. Usage: invoker-cli ${command} <${target}>`);
  }
  let bus: MessageBus | undefined;
  try {
    bus = await (deps.createMessageBus?.() ?? createDefaultMessageBus());
    await requireLiveOwnerForMutation(bus);
    await sendHeadlessExec(bus, [command, targetId]);
    process.stdout.write(`${command} accepted by live owner.\n`);
    return 0;
  } finally {
    const disconnect = (bus as { disconnect?: () => void } | undefined)?.disconnect;
    if (disconnect) {
      disconnect.call(bus);
    }
  }
}

async function runDeleteAllMutation(deps: CliDeps): Promise<number> {
  const guardExitCode = checkDeleteAllProductionGuard();
  if (guardExitCode !== undefined) return guardExitCode;

  let bus: MessageBus | undefined;
  try {
    bus = await (deps.createMessageBus?.() ?? createDefaultMessageBus());
    await requireLiveOwnerForMutation(bus);
    await sendHeadlessExec(bus, ['delete-all']);
    process.stdout.write('delete-all accepted by live owner.\n');
    return 0;
  } finally {
    const disconnect = (bus as { disconnect?: () => void } | undefined)?.disconnect;
    if (disconnect) {
      disconnect.call(bus);
    }
  }
}

async function runBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<{ accepted: number; failed: Array<{ item: T; error: unknown }> }> {
  let nextIndex = 0;
  let accepted = 0;
  const failed: Array<{ item: T; error: unknown }> = [];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      if (item === undefined) continue;
      try {
        await worker(item);
        accepted += 1;
      } catch (error) {
        failed.push({ item, error });
      }
    }
  });
  await Promise.all(workers);
  return { accepted, failed };
}

async function runRetryTasks(options: RetryTasksOptions, deps: CliDeps): Promise<number> {
  let bus: MessageBus | undefined;
  try {
    bus = await (deps.createMessageBus?.() ?? createDefaultMessageBus());
    const owner = await discoverLiveOwner(bus);
    if (!owner && !options.dryRun) {
      throw new Error(REQUIRED_OWNER_MESSAGE);
    }

    const tasks = await queryRetryTasks(options.status, bus, owner);
    if (options.dryRun) {
      if (tasks.length === 0) {
        process.stdout.write(`No tasks matched status "${options.status}".\n`);
      } else {
        process.stdout.write(`${tasks.map((task) => task.id).join('\n')}\n`);
      }
      return 0;
    }

    const result = await runBounded(tasks, options.parallel, async (task) => {
      if (!bus) throw new Error('Message bus is unavailable');
      await sendHeadlessExec(bus, ['retry-task', task.id]);
    });
    process.stdout.write(`Accepted ${result.accepted} task(s); failed ${result.failed.length} task(s).\n`);
    for (const failure of result.failed) {
      process.stderr.write(`Failed to retry ${failure.item.id}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}\n`);
    }
    return result.failed.length === 0 ? 0 : 1;
  } finally {
    const disconnect = (bus as { disconnect?: () => void } | undefined)?.disconnect;
    if (disconnect) {
      disconnect.call(bus);
    }
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
  timeoutMs = 15_000,
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
    ...(options.json ? { slowQueryThresholdMs: 0 } : {}),
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
      worktreeTargetsProvider: () => loadRuntimeConfig(options.config).worktreeTargets ?? {},
      executionPoolsProvider: () => loadRuntimeConfig(options.config).executionPools ?? {},
      executionAgentRegistry,
      callbacks: {
        onOutput: (taskId, data) => {
          if (!options.json) process.stdout.write(data);
          try {
            persistence.appendTaskOutput(taskId, data);
          } catch (err) {
            logCaughtException(`Failed to persist standalone output for ${taskId}`, err);
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

/**
 * Read the auto-fix policy knobs from the shared Invoker config so the CLI door
 * drives the engine with the same retry budget / agent the GUI owner uses.
 */
function readWorkerConfig(homeRoot: string): {
  autoFixRetries?: number;
  autoFixAgent?: string;
  externalWorkers?: ExternalWorkerConfig[];
} {
  const configPath = join(homeRoot, 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as CliRuntimeConfig;
    return {
      autoFixRetries: typeof parsed.autoFixRetries === 'number' ? parsed.autoFixRetries : undefined,
      autoFixAgent: typeof parsed.autoFixAgent === 'string' ? parsed.autoFixAgent : undefined,
      externalWorkers: Array.isArray(parsed.externalWorkers) ? parsed.externalWorkers : undefined,
    };
  } catch (err) {
    logCaughtException(`Failed to read worker config at ${configPath}`, err);
    return {};
  }
}

function workerDisplayName(kind: string): string {
  return kind === AUTO_FIX_WORKER_KIND ? 'Auto-fix' : kind;
}

function printWorkerKinds<TDeps>(registry: WorkerRegistry<TDeps>): void {
  process.stdout.write('Worker kinds\n');
  for (const worker of registry.list()) {
    process.stdout.write(`  ${worker.kind} — available (${worker.note})\n`);
  }
}

/**
 * `invoker-cli worker toggles [--enable <id>|--disable <id> ...]`
 * With no flags, prints each toggle's current state. Each flag applies
 * immediately, writing to ~/.invoker/config.json (or INVOKER_REPO_CONFIG_PATH).
 */
function runWorkerTogglesCommand(args: string[]): number {
  const changes: Array<{ spec: ReturnType<typeof findWorkerToggle>; enabled: boolean }> = [];
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag !== '--enable' && flag !== '--disable') {
      throw new Error(`Unknown option for worker toggles: "${flag}". Usage: invoker-cli worker toggles [--enable <id>|--disable <id> ...]`);
    }
    const id = args[++i];
    const spec = id ? findWorkerToggle(id) : undefined;
    if (!spec) {
      const knownIds = ONBOARDING_WORKER_TOGGLES.map((toggle) => toggle.id).join(', ');
      throw new Error(`Unknown worker toggle id: "${id ?? ''}". Known ids: ${knownIds}`);
    }
    changes.push({ spec, enabled: flag === '--enable' });
  }

  if (changes.length > 0) {
    const configPath = defaultConfigPath();
    updateInvokerConfigFile(configPath, (config) => {
      for (const { spec, enabled } of changes) {
        Object.assign(config, applyWorkerToggle(config, spec!, enabled));
      }
    });
    for (const { spec, enabled } of changes) {
      process.stdout.write(`${spec!.label}: ${enabled ? 'on' : 'off'}\n`);
    }
    return 0;
  }

  const config = readInvokerConfigFile(defaultConfigPath());
  process.stdout.write('Worker toggles\n');
  for (const spec of ONBOARDING_WORKER_TOGGLES) {
    const value = readWorkerToggleValue(config, spec);
    const enabled = value ?? spec.defaultEnabled ?? false;
    const state = enabled ? 'on' : 'off';
    process.stdout.write(`  ${spec.label}: ${value === undefined ? `${state} (default)` : state} — ${spec.description}\n`);
  }
  return 0;
}

function isExternalWorkerRuntime(worker: WorkerRuntime): worker is ExternalWorkerRuntime {
  return 'finished' in worker && worker.finished instanceof Promise;
}

/**
 * Run a registry-selected worker in the foreground. There is exactly one
 * auto-fix engine: the built-in registry entry builds the shared
 * `createRecoveryWorker` from `@invoker/execution-engine` instead of a private
 * poll loop, so the two doors can never run competing scans. The CLI owns the
 * foreground lifetime — owner discovery, connect message, the SIGINT/SIGTERM
 * block, and a deterministic stop.
 */
async function runWorker(definition: WorkerDefinition<WorkerRuntimeDependencies>, bus: MessageBus): Promise<number> {
  const owner = await discoverLiveOwner(bus);
  const homeRoot = resolveInvokerHomeRoot();
  const { autoFixRetries, autoFixAgent } = readWorkerConfig(homeRoot);

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
  const autoFixAttemptLedger = createAutoFixAttemptLedger();
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
        attemptLedger: autoFixAttemptLedger,
        getAutoFixAgent: () => autoFixAgent,
      },
    });

    worker.start();
    const ownerSuffix = owner?.ownerId ? ` to owner ${owner.ownerId}` : '';
    process.stdout.write(`${workerDisplayName(definition.kind)} worker connected${ownerSuffix}.\n`);

    const shutdownGate = Promise.withResolvers<void>();
    const shutdown = (): void => shutdownGate.resolve();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await Promise.race([
      shutdownGate.promise,
      isExternalWorkerRuntime(worker) ? worker.finished : shutdownGate.promise,
    ]);
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
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
async function runHeadlessOwnerServe(deps: CliDeps): Promise<number> {
  const repoRoot = resolveRepoRoot(__dirname, { fallback: resolve(__dirname, '../../../..') });
  const launchSpec = (deps.resolveOwnerLaunchSpec ?? resolveHeadlessOwnerLaunchSpec)(repoRoot);
  const child = (deps.spawnProcess ?? spawn)(launchSpec.command, launchSpec.args, {
    cwd: launchSpec.cwd,
    env: {
      ...process.env,
      LIBGL_ALWAYS_SOFTWARE: process.platform === 'linux' ? '1' : process.env.LIBGL_ALWAYS_SOFTWARE,
    },
    stdio: 'inherit',
  });
  return await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`headless owner exited with signal ${signal}`));
        return;
      }
      resolveExit(code ?? 0);
    });
  });
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
    if (argv[0] === 'owner') {
      if (argv[1] !== 'serve') {
        throw new Error('Unknown owner command. Usage: invoker-cli owner serve');
      }
      return await runHeadlessOwnerServe(deps);
    }
    if (argv[0] === 'worker') {
      const subcommand = argv[1] ?? 'list';
      if (subcommand === 'toggles') {
        return runWorkerTogglesCommand(argv.slice(2));
      }
      const registry = registerExternalWorkers(
        registerAutoFixWorker(createWorkerRegistry<WorkerRuntimeDependencies>()),
        readWorkerConfig(resolveInvokerHomeRoot()).externalWorkers,
      );
      if (subcommand === 'list') {
        printWorkerKinds(registry);
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
    if (argv[0] === 'query') {
      return await runQuery(parseQueryArgs(argv.slice(1)), deps);
    }
    if (argv[0] === 'retry-task' || argv[0] === 'retry' || argv[0] === 'resume') {
      if (argv.length > 2) {
        throw new Error(`Unexpected argument: ${argv[2]}`);
      }
      return await runSimpleMutation(argv[0], argv[1], deps);
    }
    if (argv[0] === 'retry-tasks') {
      return await runRetryTasks(parseRetryTasksArgs(argv.slice(1)), deps);
    }
    if (argv[0] === 'delete-all') {
      if (argv.length > 1) {
        throw new Error(`Unexpected argument: ${argv[1]}`);
      }
      return await runDeleteAllMutation(deps);
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
      throw new Error('--db-dir cannot be used with --live because the owner database is authoritative');
    }

    if (parsed.options.mode !== 'standalone') {
      bus = await (deps.createMessageBus?.() ?? createDefaultMessageBus());
      const owner = await discoverLiveOwner(bus);
      if (owner) {
        if (parsed.options.dbDir) {
          throw new Error('--db-dir cannot be used when a live owner accepts the run; use --standalone to force an isolated database');
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
        throw new Error('No running Invoker owner is reachable; start the owner or omit --live to run standalone');
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
