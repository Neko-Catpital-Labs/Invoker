/**
 * Electron Main Process — GUI + Headless CLI mode.
 *
 * GUI mode (default):
 *   electron dist/main.js
 *
 * Headless mode (same runtime, no window):
 *   electron dist/main.js --headless run <plan.yaml>
 *   electron dist/main.js --headless list
 *   electron dist/main.js --headless resume <workflowId>
 *   electron dist/main.js --headless status
 *   electron dist/main.js --headless approve <taskId>
 *   electron dist/main.js --headless reject <taskId> [reason]
 *   electron dist/main.js --headless input <taskId> <text>
 *   electron dist/main.js --headless select <taskId> <expId>
 *   electron dist/main.js --headless retry-task <taskId>
 *   electron dist/main.js --headless retry <workflowId>
 *   electron dist/main.js --headless rebase-and-retry <taskId>
 *   electron dist/main.js --headless fix <taskId>
 *   electron dist/main.js --headless resolve-conflict <taskId>
 *   electron dist/main.js --headless edit <taskId> <newCommand>
 *   electron dist/main.js --headless edit-executor <taskId> <runnerKind>
 *   electron dist/main.js --headless edit-agent <taskId> <claude|codex>
 *   electron dist/main.js --headless cancel <taskId>
 *   electron dist/main.js --headless set-merge-mode <workflowId> <mode>
 *   electron dist/main.js --headless queue
 *   electron dist/main.js --headless audit <taskId>
 *   electron dist/main.js --headless install-skills
 *   electron dist/main.js --install-skills
 *
 * Using the same Electron binary for both modes provides a consistent runtime.
 */

import { app, BrowserWindow, ipcMain, nativeImage, shell } from 'electron';
import * as path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

const enableTestCompositor = process.env.INVOKER_E2E_ENABLE_COMPOSITOR === '1' || Boolean(process.env.CAPTURE_MODE);

// Prevent desktop-wide freezes on Linux (Chromium GPU + X11/Wayland compositors).
// Defense-in-depth: API-level disable, command-line flags, and env var (LIBGL_ALWAYS_SOFTWARE).
if (process.platform === 'linux' && !enableTestCompositor) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('no-zygote');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

import { Orchestrator, CommandService, OrchestratorErrorCode } from '@invoker/workflow-core';
import type {
  PlanDefinition,
  TaskDelta,
  TaskReplacementDef,
  TaskState,
  TaskStateChanges,
} from '@invoker/workflow-core';
import { makeEnvelope, CommandError } from '@invoker/contracts';
import type { WorkResponse } from '@invoker/contracts';
import { resolveRepoRoot } from '@invoker/contracts';
import { SQLiteAdapter, ConversationRepository, SqliteTaskRepository } from '@invoker/data-store';
import { IpcBus, Channels, TransportError, TransportErrorCode } from '@invoker/transport';
import {
  WorkspaceProbeAdapter,
  ContainerProbeAdapter,
  SessionProbeAdapter,
  TerminalLauncherAdapter,
} from '@invoker/runtime-adapters';
import { composeRuntimeServices, composeHeadlessStartup } from '@invoker/runtime-service';
import type { RuntimeServices } from '@invoker/runtime-service';
import type { MessageBus } from '@invoker/transport';
import {
  ExecutorRegistry, TaskRunner,
  DockerExecutor, WorktreeExecutor, SshExecutor, GitHubMergeGateProvider, ReviewProviderRegistry,
  initializeShellEnvironment,
  RESTART_TO_BRANCH_TRACE,
  remoteFetchForPool,
  registerBuiltinAgents,
  type Executor, type ExecutorHandle,
} from '@invoker/execution-engine';
import type { Logger } from '@invoker/contracts';
import { FileAndDbLogger } from './logger.js';
import type { TaskOutputData } from './types.js';
import { loadConfig, resolveSecretsFilePath, type InvokerConfig } from './config.js';
import {
  DEFAULT_WORKTREE_MAX_CONCURRENCY,
  resolveEffectiveMaxConcurrency,
} from './execution-capacity.js';
import {
  createHourlySnapshot,
  resolveInvokerHomeRoot,
} from './delete-all-snapshot.js';
import {
  isHeadlessMutatingCommand,
  isHeadlessReadOnlyCommand,
  resolveHeadlessTarget,
  resolveHeadlessTargetWorkflowId,
} from './headless-command-classification.js';
import { backupPlan } from './plan-backup.js';
// applyPlanDefinitionDefaults removed — parsePlan() applies defaults internally
import { startApiServer, type ApiServer } from './api-server.js';
import { WorkflowMutationFacade } from './workflow-mutation-facade.js';
import {
  runHeadless,
  isDelegated,
  tryDelegateRun,
  tryDelegateResume,
  resolveDelegationTimeoutMs,
  tryDelegateExec,
  tryDelegateQuery,
  resolveAgentSession,
  createHeadlessExecutor,
  wireHeadlessApproveHook,
  type HeadlessDeps,
} from './headless.js';
import {
  approveTask as sharedApproveTask,
  deleteAllWorkflows as sharedDeleteAllWorkflows,
  deleteAllWorkflowsBulk as sharedDeleteAllWorkflowsBulk,
  fixWithAgentAction,
  rebaseAndRetry,
  recreateWithRebase,
  recreateWorkflow as sharedRecreateWorkflow,
  recreateTask as sharedRecreateTask,
  resolveConflictAction,
  selectFailureRecoveryRoute,
  selectExperiments as sharedSelectExperiments,
  setWorkflowMergeMode,
} from './workflow-actions.js';
import { spawn, execSync } from 'node:child_process';
import { openExternalTerminalForTask } from './open-terminal-for-task.js';
import { collectSystemDiagnostics } from './system-diagnostics.js';
import { installBundledSkills, resolveBundledSkillsStatus } from './bundled-skills.js';
import { createRequire } from 'node:module';
import { acquireDbWriterLock, type DbWriterLockResult } from './db-writer-lock.js';
import { applyDelta, resolveQuarantine, TaskSnapshotCache } from './delta-merge.js';
import { WorkflowMetadataInvalidator } from './workflow-metadata-invalidation.js';
import { ensureSqliteFlushDebounceForOwner } from './sqlite-flush-policy.js';
import type { WorkflowMutationPriority } from './workflow-mutation-coordinator.js';
import { PersistedWorkflowMutationCoordinator } from './persisted-workflow-mutation-coordinator.js';
import { recoverWorkflowMutationsOnStartup } from './workflow-mutation-startup.js';
import {
  dispatchStartedTasksWithGlobalTopup,
  executeGlobalTopup,
  finalizeMutationWithGlobalTopup,
  isDispatchableLaunch,
} from './global-topup.js';
import { computeDeferredLaunchTiming } from './deferred-runnable.js';
import { preemptWorkflowBeforeMutation, type WorkflowCancelResult } from './workflow-preemption.js';
import { relaunchOrphansAndStartReady } from './orphan-relaunch.js';
import { evaluateExecutingStall } from './executing-stall.js';
import { evaluateLaunchStall } from './launch-stall.js';
import { persistShutdownDiagnostic } from './shutdown-diagnostic.js';
import {
  buildActionGraphDiagnostics,
  resolveActionDiagnosticsStallThresholdMs,
} from './action-graph-diagnostics.js';

function isTaskInFlightForForcedStop(task: TaskState): boolean {
  return task.status === 'running'
    || task.status === 'fixing_with_ai'
    || (task.status === 'pending' && task.execution.phase === 'launching');
}

declare const __BUILD_SHA__: string | undefined;
declare const __BUILD_VERSION__: string | undefined;

// ── Detect headless mode ─────────────────────────────────────

// Electron passes extra args after `--` or interleaves them.
// We look for `--headless` anywhere in process.argv.
const headlessIndex = process.argv.indexOf('--headless');
const directInstallSkills = process.argv.includes('--install-skills') || process.argv.slice(2).includes('install-skills');
const isHeadless = headlessIndex !== -1 || directInstallSkills;

// In headless mode, extract the CLI args after --headless
let cliArgs = headlessIndex !== -1
  ? process.argv.slice(headlessIndex + 1)
  : directInstallSkills
    ? ['install-skills']
    : [];

// Parse --wait-for-approval flag
const waitForApprovalIndex = cliArgs.indexOf('--wait-for-approval');
const waitForApproval = waitForApprovalIndex !== -1;
if (waitForApproval) {
  cliArgs = [...cliArgs.slice(0, waitForApprovalIndex), ...cliArgs.slice(waitForApprovalIndex + 1)];
}

// Parse --no-track / --do-not-track flag
const noTrackIndex = cliArgs.findIndex((arg) => arg === '--no-track' || arg === '--do-not-track');
const noTrack = noTrackIndex !== -1;
if (noTrack) {
  cliArgs = [...cliArgs.slice(0, noTrackIndex), ...cliArgs.slice(noTrackIndex + 1)];
}

// Set app name early so Electron uses "invoker" as WM_CLASS (X11) and app_id (Wayland).
// --class tells Chromium to set WM_CLASS explicitly, preventing GNOME from
// grouping Invoker with other Electron apps (e.g. Slack).
app.name = 'invoker';
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('class', 'invoker');
}

// ── Shared state ─────────────────────────────────────────────

let messageBus: MessageBus;
let persistence: SQLiteAdapter;
let executorRegistry: ExecutorRegistry;
let orchestrator: Orchestrator;
let commandService: CommandService;
let runtimeServices: RuntimeServices;
let workflowMutationCoordinator: PersistedWorkflowMutationCoordinator | null = null;
const workflowMutationDispatcher = new Map<string, (...args: unknown[]) => Promise<unknown>>();
/**
 * The mutation context for the currently executing workflow mutation.
 * Set by the coordinator dispatch callback before invoking the handler,
 * cleared afterward. Allows fix-with-agent and conflict-resolution
 * handlers to read the AbortSignal without changing every handler signature.
 */
let activeMutationContext: import('./persisted-workflow-mutation-coordinator.js').WorkflowMutationContext | undefined;
let hourlyBackupInterval: ReturnType<typeof setInterval> | null = null;
let writerLock: DbWriterLockResult | null = null;
const workflowMutationOwnerId = `owner-${process.pid}-${Date.now()}`;
const appProcessStartedAt = Date.now();

interface GuiMutationPayload {
  channel: string;
  args: unknown[];
}

interface HeadlessRunMutationPayload {
  planPath: string;
  traceId?: string;
}

interface HeadlessResumeMutationPayload {
  workflowId: string;
  traceId?: string;
}

interface HeadlessExecMutationPayload {
  args: string[];
  waitForApproval?: boolean;
  noTrack?: boolean;
  traceId?: string;
}

// Root logger: created early in initServices() once persistence is available.
// Before initServices(), use the pre-init logger (file-only, no DB).
let logger: Logger = new FileAndDbLogger({ module: 'main' });
const buildSha = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev';
const buildVersion = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev';
logger.info(`Invoker ${buildVersion} (${buildSha})`, { module: 'startup' });

process.on('uncaughtException', (err) => {
  try {
    logger.error(`uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}`, { module: 'process' });
  } catch {
    console.error('[process] uncaughtException:', err);
  }
});

process.on('unhandledRejection', (reason) => {
  try {
    logger.error(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`, { module: 'process' });
  } catch {
    console.error('[process] unhandledRejection:', reason);
  }
});

const repoRoot = resolveRepoRoot(__dirname, { fallback: process.resourcesPath });
const invokerConfig: InvokerConfig = (() => {
  try {
    return loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
})();

function getSafeInvokerConfigForLogging(config: InvokerConfig): Record<string, unknown> {
  const safeConfig = { ...config } as Record<string, unknown> & {
    docker?: InvokerConfig['docker'];
    imageStorage?: InvokerConfig['imageStorage'];
    r2?: unknown;
  };
  delete safeConfig.r2;
  if (safeConfig.imageStorage) {
    safeConfig.imageStorage = {
      ...safeConfig.imageStorage,
      accessKeyId: '<redacted>',
      secretAccessKey: '<redacted>',
    };
  }
  if (safeConfig.docker?.secretsFile) {
    safeConfig.docker = { ...safeConfig.docker, secretsFile: '<redacted>' };
  }
  return safeConfig;
}

const effectiveMaxConcurrency = resolveEffectiveMaxConcurrency(invokerConfig.maxConcurrency);

async function maybeDelayWorkflowResumeForTest(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') return;
  const raw = process.env.INVOKER_TEST_RESUME_PENDING_DELAY_MS;
  if (!raw) return;
  const delayMs = Number(raw);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function assertDeleteAllEnabled(): void {
  if (process.env.INVOKER_ALLOW_DELETE_ALL === '1') return;
  throw new Error(
    'delete-all is disabled by default. Set INVOKER_ALLOW_DELETE_ALL=1 to enable it explicitly.',
  );
}

interface InitServicesOptions {
  readOnly?: boolean;
  executionAgentRegistry?: import('@invoker/execution-engine').AgentRegistry;
  startupSyncMode?: 'all' | 'none';
}

function getBundledSkillsStatus() {
  return resolveBundledSkillsStatus({
    isPackaged: app.isPackaged,
    repoRoot,
    resourcesPath: process.resourcesPath,
  });
}

function installPackagedSkills(mode: import('@invoker/contracts').BundledSkillsInstallMode = 'install') {
  return installBundledSkills({
    isPackaged: app.isPackaged,
    repoRoot,
    resourcesPath: process.resourcesPath,
  }, mode);
}

async function initServices(options?: InitServicesOptions): Promise<void> {
  messageBus = new IpcBus();
  const invokerHomeRoot = resolveInvokerHomeRoot();
  mkdirSync(invokerHomeRoot, { recursive: true });
  const readOnly = options?.readOnly === true;
  const dbPath = path.join(invokerHomeRoot, 'invoker.db');
  ensureSqliteFlushDebounceForOwner(process.env, readOnly);
  if (!readOnly) {
    writerLock = acquireDbWriterLock(dbPath, `main:initServices pid=${process.pid}`);
  }
  persistence = await SQLiteAdapter.create(dbPath, {
    readOnly,
    ownerCapability: !readOnly, // writable mode requires owner capability
  });
  // Upgrade root logger with DB persistence now that SQLiteAdapter is ready.
  logger = new FileAndDbLogger({ module: 'main' }, { persistence });
  const shellEnv = await initializeShellEnvironment();
  if (process.platform === 'darwin') {
    const suffix = shellEnv.reason ? ` (${shellEnv.reason})` : '';
    logger.info(
      `[init] shell environment ${shellEnv.status} via ${shellEnv.shell}; PATH=${shellEnv.path}${suffix}`,
      { module: 'init' },
    );
  }
  if (!readOnly && !hourlyBackupInterval) {
    const hourlyMs = Number(process.env.INVOKER_HOURLY_BACKUP_MS ?? 60 * 60 * 1000);
    if (Number.isFinite(hourlyMs) && hourlyMs > 0) {
      hourlyBackupInterval = setInterval(() => {
        try {
          const snapshot = createHourlySnapshot(invokerHomeRoot);
          if (snapshot) {
            logger.info(`hourly snapshot: ${snapshot}`, { module: 'backup' });
          } else {
            logger.info('hourly snapshot skipped: DB file does not exist yet', { module: 'backup' });
          }
        } catch (err) {
          logger.error(
            `hourly snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
            { module: 'backup' },
          );
        }
      }, hourlyMs);
      hourlyBackupInterval.unref?.();
      logger.info(`hourly snapshots enabled (interval=${hourlyMs}ms)`, { module: 'backup' });
    }
  }
  // Compose runtime services from persistence-backed adapters.
  // Headless startup routes through composeHeadlessStartup so the
  // headless path has an explicit composition entry point.
  const runtimeServiceDeps = {
    workspaceProbe: new WorkspaceProbeAdapter(persistence),
    containerProbe: new ContainerProbeAdapter(persistence),
    sessionProbe: new SessionProbeAdapter(persistence),
    terminalLauncher: new TerminalLauncherAdapter(),
  };
  runtimeServices = isHeadless
    ? composeHeadlessStartup(runtimeServiceDeps)
    : composeRuntimeServices(runtimeServiceDeps);

  executorRegistry = new ExecutorRegistry();
  executorRegistry.register(
    'worktree',
    new WorktreeExecutor({
      worktreeBaseDir: path.resolve(invokerHomeRoot, 'worktrees'),
      cacheDir: path.resolve(invokerHomeRoot, 'repos'),
      maxWorktrees: effectiveMaxConcurrency,
      agentRegistry: options?.executionAgentRegistry,
    }),
  );
  const taskRepository = new SqliteTaskRepository(persistence);
  orchestrator = new Orchestrator({
    persistence, messageBus,
    taskRepository,
    maxConcurrency: effectiveMaxConcurrency,
    executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
    defaultPoolId: invokerConfig.defaultPoolId,
    availablePoolIds: Object.keys(invokerConfig.executionPools ?? {}),
    deferRunningUntilLaunch: true,
  });
  commandService = new CommandService(orchestrator);

  const startupSyncMode = options?.startupSyncMode ?? 'all';
  const initLog = isHeadless
    ? (msg: string, meta?: Record<string, unknown>) => {
      process.stderr.write(meta ? `${msg} ${JSON.stringify(meta)}\n` : `${msg}\n`);
    }
    : (msg: string, meta?: Record<string, unknown>) => { logger.info(msg, { ...meta, module: 'init' }); };
  initLog('Effective configuration', { config: getSafeInvokerConfigForLogging(invokerConfig) });
  const workflows = persistence.listWorkflows();
  if (startupSyncMode === 'all') {
    try {
      orchestrator.syncAllFromDb();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`workflow invariant violation during startup sync: ${message}`, {
        module: 'init',
        error: message,
      });
      throw err;
    }
  }
  initLog(`[init] Loaded ${workflows.length} workflows from DB`);
  if (startupSyncMode === 'all') {
    initLog(`[init] Orchestrator graph has ${orchestrator.getAllTasks().length} tasks across ${workflows.length} workflows`);
  } else {
    initLog('[init] Orchestrator startup sync deferred to GUI bootstrap');
  }
}

// ── Load @invoker/surfaces at runtime ────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadSurfaces(): any {
  const req = createRequire(__filename);
  return req('@invoker/surfaces');
}

// ── Shared Slack Bot Wiring ──────────────────────────────────

interface SlackBotDeps {
  executor: TaskRunner;
  logFn: (source: string, level: string, message: string) => void;
  approveTaskAction?: (taskId: string) => Promise<void>;
  onStartPlan?: () => void;
  onPlanLoaded?: (plan: PlanDefinition) => void;
}

async function wireSlackBot(deps: SlackBotDeps): Promise<any> {
  // Load .env for Slack tokens
  try {
    const dotenv = await import('dotenv');
    dotenv.config({ path: path.resolve(repoRoot, '.env') });
  } catch {
    // dotenv not installed — rely on environment variables
  }

  const requiredVars = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_CHANNEL_ID'];
  for (const v of requiredVars) {
    if (!process.env[v]) throw new Error(`Missing env var: ${v}. Set it in .env or environment.`);
  }

  const surfaces = loadSurfaces();
  const repoLogger = logger.child({ module: 'conversation-repo' });
  const conversationRepo = new ConversationRepository(persistence, {
    info: (msg) => { repoLogger.info(msg); },
    warn: (msg) => { repoLogger.warn(msg); },
    error: (msg) => { repoLogger.error(msg); },
  });
  let repoUrl = process.env.INVOKER_REPO_URL;
  if (!repoUrl) {
    try {
      repoUrl = execSync('git remote get-url origin', { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
      deps.logFn('slack', 'warn', 'Could not detect repoUrl from git remote; plans will require repoUrl in YAML');
    }
  }

  const slack = new surfaces.SlackSurface({
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    channelId: process.env.SLACK_CHANNEL_ID!,
    cursorCommand: process.env.CURSOR_COMMAND ?? 'agent',
    model: process.env.CURSOR_MODEL,
    workingDir: repoRoot,
    conversationRepo,
    defaultBranch: invokerConfig.defaultBranch,
    repoUrl,
    log: deps.logFn,
    planningTimeoutSeconds: invokerConfig.planningTimeoutSeconds,
    planningHeartbeatIntervalSeconds: invokerConfig.planningHeartbeatIntervalSeconds,
  });

  await slack.start(async (command: any) => {
    deps.logFn('trace', 'info', `slackBot: command received — type=${command.type}`);
    switch (command.type) {
      case 'approve': {
        const taskId = command.taskId as string;
        if (deps.approveTaskAction) {
          await deps.approveTaskAction(taskId);
          break;
        }
        await sharedApproveTask(taskId, {
          orchestrator,
          taskExecutor: deps.executor,
          approve: async (approvedTaskId) => {
            const result = await commandService.approve(
              makeEnvelope('approve', 'surface', 'task', { taskId: approvedTaskId }),
            );
            if (!result.ok) throw new Error(result.error.message);
            return result.data;
          },
          resumeAfterFixApproval: async (approvedTaskId) => {
            const result = await commandService.resumeTaskAfterFixApproval(
              makeEnvelope('approve', 'surface', 'task', { taskId: approvedTaskId }),
            );
            if (!result.ok) throw new Error(result.error.message);
            return result.data;
          },
        });
        break;
      }
      case 'reject': {
        const env = makeEnvelope('reject', 'surface', 'task', { taskId: command.taskId as string, reason: command.reason as string | undefined });
        const rejectResult = await commandService.reject(env);
        if (!rejectResult.ok) throw new Error(rejectResult.error.message);
        break;
      }
      case 'select_experiment': {
        const started = orchestrator.selectExperiment(command.taskId, command.experimentId);
        await deps.executor.executeTasks(started);
        break;
      }
      case 'provide_input':
        orchestrator.provideInput(command.taskId, command.input);
        break;
      case 'get_status':
        break;
      case 'start_plan': {
        const { parsePlan } = await import('./plan-parser.js');
        const planText = command.planText as string;
        const plan = parsePlan(planText);
        deps.logFn('trace', 'info', `slackBot: loading plan "${plan.name}" (${plan.tasks.length} tasks)`);
        deps.onStartPlan?.();
        deps.onPlanLoaded?.(plan);
        backupPlan(plan, undefined, logger);
        orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
        const started = orchestrator.startExecution();
        deps.logFn('trace', 'info', `slackBot: startExecution returned ${started.length} tasks: [${started.map((t: any) => t.id).join(', ')}]`);
        await deps.executor.executeTasks(started);
        break;
      }
    }
  });

  return slack;
}

// ── ANSI Helpers ─────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';

// ══════════════════════════════════════════════════════════════
// HEADLESS MODE
// ══════════════════════════════════════════════════════════════

if (isHeadless) {
  app.whenReady().then(async () => {
    const agentRegistry = registerBuiltinAgents();
    const command = cliArgs[0];
    const readOnlyMode = isHeadlessReadOnlyCommand(cliArgs);
    const mutatingMode = isHeadlessMutatingCommand(cliArgs);
    const standaloneMode = process.env.INVOKER_HEADLESS_STANDALONE === '1' || command === 'owner-serve';
    const ownsHeadlessShutdown = standaloneMode && !readOnlyMode && command === 'owner-serve';
    const queueQueryMode = command === 'queue' || (command === 'query' && cliArgs[1] === 'queue');

    const delegatedQueueOutputFormat = (): 'json' | 'jsonl' | 'label' | 'text' => {
      const outputIndex = cliArgs.indexOf('--output');
      const value = outputIndex >= 0 ? cliArgs[outputIndex + 1] : undefined;
      if (value === 'json' || value === 'jsonl' || value === 'label') return value;
      return 'text';
    };

    const writeDelegatedQueueStatus = (status: Record<string, unknown>): void => {
      const format = delegatedQueueOutputFormat();
      const running = Array.isArray(status.running) ? status.running as Array<Record<string, unknown>> : [];
      const queued = Array.isArray(status.queued) ? status.queued as Array<Record<string, unknown>> : [];
      if (format === 'json') {
        process.stdout.write(JSON.stringify(status) + '\n');
        return;
      }
      if (format === 'jsonl') {
        for (const task of running) {
          process.stdout.write(JSON.stringify({ ...task, state: 'running' }) + '\n');
        }
        for (const task of queued) {
          process.stdout.write(JSON.stringify({ ...task, state: 'queued' }) + '\n');
        }
        return;
      }
      if (format === 'label') {
        const ids = [...running, ...queued]
          .map((task) => String(task.taskId ?? ''))
          .filter(Boolean);
        process.stdout.write(ids.join('\n') + '\n');
        return;
      }
      const runningCount = Number(status.runningCount ?? running.length);
      const maxConcurrency = Number(status.maxConcurrency ?? 0);
      process.stdout.write(`running=${runningCount}/${maxConcurrency} queued=${queued.length}\n`);
    };

    // Try delegation for mutating commands first (owner mode).
    // In standalone mode we skip delegation and run locally.
    if (mutatingMode && !standaloneMode) {
      // Delegating headless commands must never become the IPC server.
      // Otherwise a transient submitter can steal the transport socket away
      // from the actual shared mutation owner.
      const delegationBus = new IpcBus(undefined, { allowServe: false });
      try {
        await delegationBus.ready();

        let delegated = false;
        if (command === 'run') {
          const planPath = cliArgs[1];
          if (!planPath) throw new Error('Missing plan file. Usage: --headless run <plan.yaml>');
          delegated = isDelegated(await tryDelegateRun(planPath, delegationBus, waitForApproval, noTrack));
        } else if (command === 'resume') {
          const workflowId = cliArgs[1];
          if (!workflowId) throw new Error('Missing workflowId. Usage: --headless resume <id>');
          delegated = isDelegated(await tryDelegateResume(workflowId, delegationBus, waitForApproval, noTrack));
        } else {
          const timeoutMs = noTrack ? undefined : await resolveDelegationTimeoutMs(cliArgs);
          delegated = isDelegated(await tryDelegateExec(cliArgs, delegationBus, waitForApproval, noTrack, timeoutMs));
        }

        if (delegated) {
          // Successfully delegated to owner
          delegationBus.disconnect();
          process.exit(process.exitCode ?? 0);
          return; // Guard: process.exit() may not halt in Electron async context
        }

        // Delegation failed: no owner handler available.
        delegationBus.disconnect();
        if (!standaloneMode) {
          process.stderr.write(
            `${RED}Error:${RESET} Mutation command "${command}" requires a running owner process.\n` +
            `\n${BOLD}Options:${RESET}\n` +
            `  1. Start the interactive process: ${BOLD}electron dist/main.js${RESET}\n` +
            `  2. Run in standalone mode: ${BOLD}INVOKER_HEADLESS_STANDALONE=1 electron dist/main.js --headless ${cliArgs.join(' ')}${RESET}\n` +
            `\nStandalone mode opens a writable database. Only use it when no other process is accessing the database.\n`
          );
          process.exit(1);
          return; // Guard: process.exit() may not halt in Electron async context
        }
      } catch (err) {
        process.stderr.write(`${RED}Delegation error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
        delegationBus.disconnect();
        process.exit(1);
        return; // Guard: process.exit() may not halt in Electron async context
      }
    }

    if (readOnlyMode && queueQueryMode && !standaloneMode) {
      const delegationBus = new IpcBus(undefined, { allowServe: false });
      try {
        await delegationBus.ready();
        const delegated = await tryDelegateQuery(delegationBus, { kind: 'queue' }, 5_000);
        delegationBus.disconnect();
        if (delegated) {
          writeDelegatedQueueStatus(delegated);
          process.exit(0);
          return;
        }
      } catch (err) {
        delegationBus.disconnect();
        process.stderr.write(`${RED}Delegation error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
        return;
      }
    }

    let exitCode = 0;
    try {
      // Standalone mode: initialize services and run headless
      await initServices({
        readOnly: readOnlyMode,
        executionAgentRegistry: agentRegistry,
      });

      const headlessDeps: HeadlessDeps = {
        logger,
        orchestrator, persistence, executorRegistry, messageBus,
        repoRoot, invokerConfig, initServices, wireSlackBot,
        commandService,
        getUiPerfStats: () => ({
          ts: new Date().toISOString(),
          mainDeltaToUi: 0,
          dbPollCreated: 0,
          dbPollUpdatedAsCreated: 0,
          dbPollUpdatedAsUpdated: 0,
          rendererReports: 0,
          maxRendererEventLoopLagMs: 0,
          maxRendererHiddenEventLoopLagMs: 0,
          maxRendererCumulativeLagMs: 0,
          maxRendererTickDeltaMs: 0,
          maxRendererLongTaskMs: 0,
        }),
        resetUiPerfStats: () => {},
        waitForApproval,
        noTrack,
        executionAgentRegistry: agentRegistry,
        getBundledSkillsStatus,
        installBundledSkills: installPackagedSkills,
        runtimeServices,
      };

      const createStandaloneTaskExecutor = (): TaskRunner => {
        const executor = createHeadlessExecutor(headlessDeps);
        wireHeadlessApproveHook(headlessDeps, executor);
        return executor;
      };

      const executeStandaloneHeadlessRun = async (payload: HeadlessRunMutationPayload): Promise<unknown> => {
        const { parsePlanFile } = await import('./plan-parser.js');
        const plan = await parsePlanFile(payload.planPath);
        const executor = createStandaloneTaskExecutor();
        backupPlan(plan, undefined, logger);
        const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
        orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
        const workflowId = orchestrator.getWorkflowIds().find((id) => !wfIdsBefore.has(id));
        if (!workflowId) {
          throw new Error(`Failed to resolve workflow id for delegated plan: ${payload.planPath}`);
        }
        const started = orchestrator.startExecution();
        await executor.executeTasks(started);
        logger.info(`standalone started ${started.length} tasks for workflow "${workflowId}"`, { module: 'ipc-delegate' });
        const tasks = orchestrator.getAllTasks().filter((task) => task.config.workflowId === workflowId);
        return { workflowId, tasks };
      };

      const executeStandaloneHeadlessResume = async (payload: HeadlessResumeMutationPayload): Promise<unknown> => {
        const { workflowId } = payload;
        const executor = createStandaloneTaskExecutor();
        orchestrator.syncFromDb(workflowId);
        const started = relaunchOrphansAndStartReady(orchestrator, logger, 'standalone-ipc-delegate', workflowId);
        await executor.executeTasks(started);
        logger.info(`standalone resumed ${started.length} tasks for workflow "${workflowId}"`, { module: 'ipc-delegate' });
        const tasks = orchestrator.getAllTasks().filter((task) => task.config.workflowId === workflowId);
        return { workflowId, tasks };
      };

      const executeStandaloneGuiMutation = async (payload: GuiMutationPayload): Promise<unknown> => {
        switch (payload.channel) {
          case 'invoker:load-plan': {
            const planText = String(payload.args[0] ?? '');
            const { parsePlan } = await import('./plan-parser.js');
            const plan = parsePlan(planText);
            backupPlan(plan, undefined, logger);
            orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
            return undefined;
          }
          case 'invoker:start': {
            const executor = createStandaloneTaskExecutor();
            const started = orchestrator.startExecution();
            await executor.executeTasks(started);
            return started;
          }
          case 'invoker:set-merge-branch': {
            const workflowId = String(payload.args[0]);
            const baseBranch = String(payload.args[1]);
            persistence.updateWorkflow(workflowId, { baseBranch });
            const tasks = persistence.loadTasks(workflowId);
            const mergeTask = tasks.find((task) => task.config.isMergeNode);
            if (!mergeTask) return undefined;
            const executor = createStandaloneTaskExecutor();
            const started = orchestrator.retryTask(mergeTask.id);
            await dispatchStartedTasksWithGlobalTopup({
              orchestrator,
              taskExecutor: executor,
              logger,
              context: 'standalone.set-merge-branch',
              started,
              scopedTaskIds: [mergeTask.id],
            });
            return undefined;
          }
          case 'invoker:replace-task': {
            const taskId = String(payload.args[0]);
            const replacementTasks = payload.args[1] as TaskReplacementDef[];
            const envelope = makeEnvelope('replace-task', 'ui', 'task', { taskId, replacementTasks });
            const result = await commandService.replaceTask(envelope);
            if (!result.ok) throw new Error(result.error.message);
            const runnable = result.data.filter(isDispatchableLaunch);
            if (runnable.length > 0) {
              const executor = createStandaloneTaskExecutor();
              await executor.executeTasks(runnable);
            }
            return result.data;
          }
          case 'invoker:check-pr-statuses': {
            const executor = createStandaloneTaskExecutor();
            await executor.checkMergeGateStatuses();
            return undefined;
          }
          case 'invoker:check-pr-status': {
            const executor = createStandaloneTaskExecutor();
            const tasks = orchestrator.getAllTasks();
            const awaitingMergeGates = tasks.filter(
              (task) => task.config.isMergeNode && (task.status === 'review_ready' || task.status === 'awaiting_approval'),
            );
            await Promise.all(awaitingMergeGates.map((task) => executor.checkPrApprovalNow(task.id)));
            return undefined;
          }
          case 'invoker:select-experiment': {
            const taskId = String(payload.args[0]);
            const experimentId = payload.args[1] as string | string[];
            const ids = Array.isArray(experimentId) ? experimentId : [experimentId];
            const executor = createStandaloneTaskExecutor();
            if (ids.length === 1) {
              const envelope = makeEnvelope('select-experiment', 'ui', 'task', { taskId, experimentId: ids[0] });
              const result = await commandService.selectExperiment(envelope);
              if (!result.ok) throw new Error(result.error.message);
              const runnable = result.data.filter(isDispatchableLaunch);
              if (runnable.length > 0) await executor.executeTasks(runnable);
              return undefined;
            }
            const newlyStarted = await sharedSelectExperiments(taskId, ids, { orchestrator, taskExecutor: executor });
            await executor.executeTasks(newlyStarted);
            return undefined;
          }
          case 'invoker:set-task-external-gate-policies': {
            const taskId = String(payload.args[0]);
            const updates = payload.args[1] as Array<{ workflowId: string; taskId?: string; gatePolicy: 'completed' | 'review_ready' }>;
            const envelope = makeEnvelope('set-gate-policies', 'ui', 'task', { taskId, updates });
            const result = await commandService.setTaskExternalGatePolicies(envelope);
            if (!result.ok) throw new Error(result.error.message);
            const runnable = result.data.filter(isDispatchableLaunch);
            if (runnable.length > 0) {
              const executor = createStandaloneTaskExecutor();
              await executor.executeTasks(runnable);
            }
            return undefined;
          }
          default:
            throw new Error(`Unsupported internal mutation for standalone owner: ${payload.channel}`);
        }
      };

      // In standalone owner mode, serve delegated requests from peer headless processes.
      if (standaloneMode && messageBus) {
        const standaloneOwnerIdleTimeoutMs = Number.parseInt(
          process.env.INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS ?? '2000',
          10,
        );
        let standaloneOwnerLastActivityAt = Date.now();
        const noteStandaloneOwnerActivity = (): void => {
          standaloneOwnerLastActivityAt = Date.now();
        };
        headlessDeps.isStandaloneOwnerIdle = () => {
          const idleForMs = Date.now() - standaloneOwnerLastActivityAt;
          if (idleForMs < standaloneOwnerIdleTimeoutMs) return false;
          const hasQueuedOrRunningMutations =
            persistence.listWorkflowMutationIntents(undefined, ['queued', 'running']).length > 0;
          if (hasQueuedOrRunningMutations) return false;
          return !orchestrator.getAllTasks().some(
            (task) => task.status === 'running' || task.status === 'fixing_with_ai',
          );
        };

        const classifyStandaloneHeadlessExecMutation = (
          payload: HeadlessExecMutationPayload,
        ): { workflowId?: string; priority: WorkflowMutationPriority } => {
          const [command, arg0] = payload.args;
          if (!command) return { priority: 'normal' };

          const standaloneWorkflowIdForTaskArg = (taskIdArg: unknown): string => {
            return resolveHeadlessTargetWorkflowId(taskIdArg, persistence);
          };

          switch (command) {
            case 'retry':
              return {
                workflowId: arg0 === undefined ? undefined : standaloneWorkflowIdForTaskArg(arg0),
                priority: 'high',
              };
            case 'recreate':
            case 'cancel-workflow':
              return { workflowId: arg0 === undefined ? undefined : String(arg0), priority: 'high' };
            case 'recreate-with-rebase':
              return { workflowId: standaloneWorkflowIdForTaskArg(arg0), priority: 'high' };
            case 'rebase':
            case 'cancel':
            case 'recreate-task':
              return { workflowId: standaloneWorkflowIdForTaskArg(arg0), priority: 'high' };
            case 'approve':
            case 'reject':
            case 'select':
            case 'fix':
            case 'resolve-conflict':
              return { workflowId: standaloneWorkflowIdForTaskArg(arg0), priority: 'normal' };
            default:
              return { priority: 'normal' };
          }
        };

        const runStandaloneWorkflowMutation = async <T>(
          workflowId: string | undefined,
          priority: WorkflowMutationPriority,
          channel: string,
          args: unknown[],
          op: () => Promise<T>,
        ): Promise<T> => {
          if (!workflowId) return op();
          if (!workflowMutationCoordinator || !workflowMutationDispatcher.has(channel)) {
            return op();
          }
          return workflowMutationCoordinator.enqueue<T>(workflowId, priority, channel, args);
        };

        if (!workflowMutationDispatcher.has('headless.exec')) {
          workflowMutationDispatcher.set('headless.exec', async (payloadArg: unknown) => {
            const payload = payloadArg as HeadlessExecMutationPayload;
            await runHeadless(payload.args, {
              ...headlessDeps,
              waitForApproval: payload.waitForApproval,
              noTrack: payload.noTrack,
              signal: activeMutationContext?.signal,
              mutationTiming: activeMutationContext?.mutationTiming,
            });
            return { ok: true };
          });
        }
        if (!workflowMutationCoordinator) {
          workflowMutationCoordinator = new PersistedWorkflowMutationCoordinator(
            persistence,
            workflowMutationOwnerId,
            async (channel: string, args: unknown[], context) => {
              const handler = workflowMutationDispatcher.get(channel);
              if (!handler) {
                throw new Error(`No workflow mutation dispatcher registered for ${channel}`);
              }
              activeMutationContext = context;
              try {
                return await handler(...args);
              } finally {
                activeMutationContext = undefined;
              }
            },
            { logger },
          );
        }

        const executeStandaloneHeadlessRun = async (
          payload: HeadlessRunMutationPayload,
        ): Promise<{ workflowId: string; tasks: TaskState[] }> => {
          const { parsePlanFile } = await import('./plan-parser.js');
          const plan = await parsePlanFile(payload.planPath);
          backupPlan(plan, undefined, logger);
          const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
          orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
          const workflowId = orchestrator.getWorkflowIds().find(id => !wfIdsBefore.has(id))!;
          const started = orchestrator.startExecution();
          createStandaloneTaskExecutor().executeTasks(started).catch(err => {
            logger.error(`headless.run: executeTasks failed for "${workflowId}": ${err}`, { module: 'ipc-delegate' });
          });
          logger.info(`started ${started.length} tasks for workflow "${workflowId}"`, { module: 'ipc-delegate' });
          const tasks = orchestrator.getAllTasks().filter(t => t.config.workflowId === workflowId);
          return { workflowId, tasks };
        };

        const executeStandaloneHeadlessResume = async (
          payload: HeadlessResumeMutationPayload,
        ): Promise<{ workflowId: string; tasks: TaskState[] }> => {
          const { workflowId } = payload;
          orchestrator.syncFromDb(workflowId);
          const executor = createStandaloneTaskExecutor();

          const allStarted = relaunchOrphansAndStartReady(orchestrator, logger, 'ipc-delegate', workflowId);
          if (allStarted.length > 0) {
            executor.executeTasks(allStarted).catch(err => {
              logger.error(`headless.resume: executeTasks failed for "${workflowId}": ${err}`, { module: 'ipc-delegate' });
            });
          }
          executor.resumeMergeGatePolling();
          const tasks = orchestrator.getAllTasks().filter(t => t.config.workflowId === workflowId);
          return { workflowId, tasks };
        };

        messageBus.onRequest('headless.run', async (req: unknown) => {
          noteStandaloneOwnerActivity();
          const { planPath, traceId } = req as { planPath: string; traceId?: string };
          logger.info(
            `headless.run received trace=${traceId ?? '<none>'} planPath="${planPath}" ownerId=${workflowMutationOwnerId} mode=standalone`,
            { module: 'ipc-delegate' },
          );
          const result = await executeStandaloneHeadlessRun({ planPath });
          logger.info(
            `headless.run accepted trace=${traceId ?? '<none>'} workflow="${result.workflowId}" tasks=${result.tasks.length} mode=standalone`,
            { module: 'ipc-delegate' },
          );
          return result;
        });
        messageBus.onRequest('headless.owner-ping', async () => {
          noteStandaloneOwnerActivity();
          return {
            ok: true,
            ownerId: workflowMutationOwnerId,
            mode: 'standalone',
          };
        });
        messageBus.onRequest('headless.query', async (req: unknown) => {
          noteStandaloneOwnerActivity();
          const { kind, reset } = req as { kind?: string; reset?: boolean };
          if (kind === 'ui-perf') {
            if (reset) {
              headlessDeps.resetUiPerfStats?.();
            }
            return {
              ownerMode: 'standalone',
              ...(headlessDeps.getUiPerfStats?.() ?? {}),
            };
          }
          if (kind === 'queue') {
            return orchestrator.getQueueStatus() as unknown as Record<string, unknown>;
          }
          throw new Error(`Unsupported headless query: ${String(kind)}`);
        });
        messageBus.onRequest('headless.resume', async (req: unknown) => {
          noteStandaloneOwnerActivity();
          const { workflowId, traceId } = req as { workflowId: string; traceId?: string };
          logger.info(
            `headless.resume received trace=${traceId ?? '<none>'} workflowId="${workflowId}" ownerId=${workflowMutationOwnerId} mode=standalone`,
            { module: 'ipc-delegate' },
          );
          const result = await executeStandaloneHeadlessResume({ workflowId });
          logger.info(
            `headless.resume accepted trace=${traceId ?? '<none>'} workflow="${result.workflowId}" tasks=${result.tasks.length} mode=standalone`,
            { module: 'ipc-delegate' },
          );
          return result;
        });
        messageBus.onRequest('headless.exec', async (req: unknown) => {
          noteStandaloneOwnerActivity();
          const { args, waitForApproval: delegatedWait, noTrack: delegatedNoTrack, traceId } =
            req as { args: string[]; waitForApproval?: boolean; noTrack?: boolean; traceId?: string };
          if (!Array.isArray(args) || args.length === 0) {
            throw new Error('Missing delegated headless command arguments');
          }
          logger.info(
            `headless.exec received trace=${traceId ?? '<none>'} args="${args.join(' ')}" ownerId=${workflowMutationOwnerId} mode=standalone`,
            { module: 'ipc-delegate' },
          );
          const payload: HeadlessExecMutationPayload = {
            args,
            waitForApproval: delegatedWait,
            noTrack: delegatedNoTrack,
            traceId,
          };
          const { workflowId, priority } = classifyStandaloneHeadlessExecMutation(payload);
          if (delegatedNoTrack && workflowId && workflowMutationCoordinator) {
            const intentId = workflowMutationCoordinator.submit(workflowId, priority, 'headless.exec', [payload], {
              deferDrain: true,
            });
            logger.info(
              `headless.exec accepted trace=${traceId ?? '<none>'} workflow="${workflowId}" intent=${intentId} noTrack=true priority=${priority} mode=standalone`,
              { module: 'ipc-delegate' },
            );
            return { ok: true, intentId };
          }
          await runStandaloneWorkflowMutation(workflowId, priority, 'headless.exec', [payload], async () => {
            await runHeadless(args, {
              ...headlessDeps,
              waitForApproval: delegatedWait,
              noTrack: delegatedNoTrack,
              signal: activeMutationContext?.signal,
              mutationTiming: activeMutationContext?.mutationTiming,
            });
          });
          return { ok: true };
        });
      }

      await runHeadless(cliArgs, headlessDeps);
    } catch (err) {
      process.stderr.write(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
      exitCode = 1;
    } finally {
      if (ownsHeadlessShutdown && executorRegistry) {
        await Promise.all(executorRegistry.getAll().map(f => f.destroyAll().catch(() => undefined)));
      }
      if (ownsHeadlessShutdown && orchestrator) {
        for (const task of orchestrator.getAllTasks()) {
          if (isTaskInFlightForForcedStop(task)) {
            if (persistence) persistShutdownDiagnostic(task, persistence);
            orchestrator.handleWorkerResponse({
              requestId: `quit-${task.id}`,
              actionId: task.id,
              attemptId: task.execution.selectedAttemptId,
              executionGeneration: task.execution.generation ?? 0,
              status: 'failed',
              outputs: { exitCode: 1, error: 'Application quit' },
            });
          }
        }
      }
      if (persistence) persistence.close();
      if (writerLock) writerLock.release();
      if (messageBus) messageBus.disconnect();
    }
    process.exit(exitCode);
  }).catch((err) => {
    process.stderr.write(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
} else {
  // ══════════════════════════════════════════════════════════════
  // GUI MODE
  // ══════════════════════════════════════════════════════════════
  if (process.env.NODE_ENV !== 'test') {
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      app.quit();
    } else {
      setupGuiMode();
    }
  } else {
    setupGuiMode();
  }
}

// ══════════════════════════════════════════════════════════════
// GUI MODE
// ══════════════════════════════════════════════════════════════

  function setupGuiMode(): void {
  const agentRegistry = registerBuiltinAgents();
  let mainWindow: BrowserWindow | null = null;
  let taskExecutor: TaskRunner | null = null;
  let apiServer: ApiServer | null = null;
  let ownerMode = true;
  const taskHandles = new Map<string, { handle: ExecutorHandle; executor: Executor }>();
  const launchingTasks = new Set<string>();
  const guiMutationHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  let dbPollInterval: ReturnType<typeof setInterval> | null = null;
  let activityPollInterval: ReturnType<typeof setInterval> | null = null;
  let uiPerfLogInterval: ReturnType<typeof setInterval> | null = null;
  const lastKnownTaskStates = new TaskSnapshotCache();
  const deferredWorkflowLaunches = new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    taskIds: string[];
    firstScheduledAtMs: number;
  }>();
  const cancelDeferredWorkflowLaunch = (workflowId: string, reason: string): void => {
    const pending = deferredWorkflowLaunches.get(workflowId);
    if (!pending) return;
    clearTimeout(pending.timer);
    deferredWorkflowLaunches.delete(workflowId);
    logger.info(
      `cancelled deferred runnable launch workflow="${workflowId}" reason="${reason}" tasks=[${pending.taskIds.join(',')}]`,
      { module: 'ipc-delegate' },
    );
  };
  const pendingOutputBuffers = new Map<string, string[]>();
  const outputFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingUiTaskDeltas: TaskDelta[] = [];
  let uiTaskDeltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let workflowMetadataInvalidator: WorkflowMetadataInvalidator | null = null;
  let lastKnownWorkflowCount = 0;
  let lastActivityLogId = 0;
  let startupWorkflowId: string | null = null;
  let uiInteractive = false;
  let deferredStartupTriggered = false;
  const traceUiDeltaFlow = process.env.INVOKER_TRACE_UI_DELTA === '1';
  const traceDbPollPerTask = process.env.INVOKER_TRACE_DB_POLL === '1';
  const traceTaskOutput = process.env.INVOKER_TRACE_TASK_OUTPUT === '1';
  const launchingStallTimeoutMs = Number.parseInt(
    process.env.INVOKER_LAUNCHING_STALL_TIMEOUT_MS ?? '60000',
    10,
  ) || 60000;
  const executingStallTimeoutMs = Number.parseInt(
    process.env.INVOKER_EXECUTING_STALL_TIMEOUT_MS ?? '180000',
    10,
  ) || 180000;
  const uiPerfStats = {
    mainDeltaToUi: 0,
    dbPollCreated: 0,
    dbPollUpdatedAsCreated: 0,
    dbPollUpdatedAsUpdated: 0,
    rendererReports: 0,
    maxRendererEventLoopLagMs: 0,
    maxRendererHiddenEventLoopLagMs: 0,
    maxRendererCumulativeLagMs: 0,
    maxRendererTickDeltaMs: 0,
    maxRendererLongTaskMs: 0,
  };
  const startupMarks = new Map<string, number>();
  const startupPhaseDetails: Array<Record<string, unknown>> = [];
  const recordStartupMark = (phase: string, extra?: Record<string, unknown>): void => {
    const elapsedMs = Date.now() - appProcessStartedAt;
    startupMarks.set(phase, elapsedMs);
    const payload = {
      ts: new Date().toISOString(),
      metric: 'startup_phase',
      phase,
      elapsedMs,
      ...(extra ?? {}),
    };
    logger.info(`startup phase ${phase} elapsed=${elapsedMs}ms`, { module: 'startup' });
    try {
      persistence.writeActivityLog('startup-phase', 'info', JSON.stringify(payload));
    } catch {
      // best effort; db can be locked during startup
    }
  };
  const recordStartupDuration = (phase: string, startedAtMs: number, extra?: Record<string, unknown>): void => {
    const durationMs = Date.now() - startedAtMs;
    startupPhaseDetails.push({
      phase,
      durationMs,
      ...(extra ?? {}),
    });
    recordStartupMark(phase, {
      durationMs,
      ...(extra ?? {}),
    });
  };
  const recordStartupDetail = (phase: string, details: Record<string, unknown>): void => {
    startupPhaseDetails.push({
      phase,
      ...details,
    });
    recordStartupMark(phase, details);
  };
  const timeStartupPhase = <T>(phase: string, work: () => T, extra?: (result: T) => Record<string, unknown>): T => {
    const startedAtMs = Date.now();
    const result = work();
    recordStartupDuration(phase, startedAtMs, extra?.(result));
    return result;
  };

  const resetUiPerfStats = (): void => {
    uiPerfStats.mainDeltaToUi = 0;
    uiPerfStats.dbPollCreated = 0;
    uiPerfStats.dbPollUpdatedAsCreated = 0;
    uiPerfStats.dbPollUpdatedAsUpdated = 0;
    uiPerfStats.rendererReports = 0;
    uiPerfStats.maxRendererEventLoopLagMs = 0;
    uiPerfStats.maxRendererHiddenEventLoopLagMs = 0;
    uiPerfStats.maxRendererCumulativeLagMs = 0;
    uiPerfStats.maxRendererTickDeltaMs = 0;
    uiPerfStats.maxRendererLongTaskMs = 0;
  };

  const getUiPerfStats = (): Record<string, unknown> => ({
    ...uiPerfStats,
    startupMarks: Object.fromEntries(startupMarks.entries()),
    startupPhaseDetails: [...startupPhaseDetails],
    ts: new Date().toISOString(),
  });

  const flushTaskOutput = (taskId: string): void => {
    const timer = outputFlushTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      outputFlushTimers.delete(taskId);
    }
    const chunks = pendingOutputBuffers.get(taskId);
    if (!chunks || chunks.length === 0) {
      return;
    }
    pendingOutputBuffers.delete(taskId);
    const data = chunks.join('');
    if (traceTaskOutput) {
      logger.info(`${taskId}: ${data.trimEnd()}`, { module: 'output' });
    }
    const outputData: TaskOutputData = { taskId, data };
    messageBus.publish(Channels.TASK_OUTPUT, outputData);
    try {
      persistence.appendTaskOutput(taskId, data);
      persistence.appendOutputChunk(taskId, data);
    } catch (err) {
      logger.error(`Failed to persist output for ${taskId}: ${err}`, { module: 'output' });
    }
  };

  const enqueueTaskOutput = (taskId: string, data: string): void => {
    const chunks = pendingOutputBuffers.get(taskId) ?? [];
    chunks.push(data);
    pendingOutputBuffers.set(taskId, chunks);
    if (outputFlushTimers.has(taskId)) {
      return;
    }
    const timer = setTimeout(() => flushTaskOutput(taskId), 100);
    timer.unref?.();
    outputFlushTimers.set(taskId, timer);
  };

  const flushUiTaskDeltas = (): void => {
    if (uiTaskDeltaFlushTimer) {
      clearTimeout(uiTaskDeltaFlushTimer);
      uiTaskDeltaFlushTimer = null;
    }
    if (!mainWindow || mainWindow.isDestroyed() || !uiInteractive || pendingUiTaskDeltas.length === 0) {
      pendingUiTaskDeltas.length = 0;
      return;
    }
    const batch = pendingUiTaskDeltas.splice(0, pendingUiTaskDeltas.length);
    if (batch.length === 1) {
      mainWindow.webContents.send('invoker:task-delta', batch[0]);
      return;
    }
    mainWindow.webContents.send('invoker:task-delta-batch', batch);
  };

  const sendTaskDeltaToRenderer = (delta: TaskDelta): void => {
    workflowMetadataInvalidator?.markFromTaskDelta(delta);
    if (!mainWindow || mainWindow.isDestroyed() || !uiInteractive) {
      return;
    }
    pendingUiTaskDeltas.push(delta);
    if (uiTaskDeltaFlushTimer) {
      return;
    }
    uiTaskDeltaFlushTimer = setTimeout(() => flushUiTaskDeltas(), 25);
    uiTaskDeltaFlushTimer.unref?.();
  };

  const executeFixWithAgentMutation = async (
    taskId: string,
    agentName?: string,
  ): Promise<TaskState[]> => {
    const task = orchestrator.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    const savedError = task.execution.error ?? '';
    const recoveryRoute = selectFailureRecoveryRoute(task, savedError);
    logger.info(
      `fix-with-agent: "${taskId}" agent=${agentName ?? 'claude'} source=ipc route=${recoveryRoute.kind}`,
      { module: 'ipc' },
    );

    const result = await fixWithAgentAction(
      taskId,
      {
        orchestrator,
        persistence,
        taskExecutor: requireTaskExecutor(),
        autoApproveAIFixes: invokerConfig.autoApproveAIFixes,
      },
      {
        agentName,
        recoveryRoute,
        recreateOutputLabel: 'Fix with AI',
        failureOutputLabel: `Fix with ${agentName ?? 'Claude'}`,
        signal: activeMutationContext?.signal,
      },
    );
    return result.started;
  };

  const parseExecutionDate = (value: unknown): Date | undefined => {
    if (!value) return undefined;
    if (value instanceof Date) return value;
    if (typeof value !== 'string') return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  };

  // Focus existing window when a second instance is launched
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  function rebuildTaskRunner(): void {
    taskExecutor = new TaskRunner({
      orchestrator,
      persistence,
      executorRegistry,
      executionAgentRegistry: agentRegistry,
      cwd: repoRoot,
      defaultBranch: invokerConfig.defaultBranch,
      dockerConfig: {
        imageName: invokerConfig.docker?.imageName,
        secretsFile: resolveSecretsFilePath(invokerConfig),
      },
      remoteTargetsProvider: () => loadConfig().remoteTargets ?? {},
      executionPoolsProvider: () => loadConfig().executionPools ?? {},
      mergeGateProvider: new GitHubMergeGateProvider(),
      reviewProviderRegistry: (() => {
        const registry = new ReviewProviderRegistry();
        registry.register(new GitHubMergeGateProvider());
        return registry;
      })(),
      callbacks: {
        onOutput: (taskId, data) => {
          enqueueTaskOutput(taskId, data);
        },
        onLaunchAccepted: (taskId) => {
          launchingTasks.add(taskId);
          logger.info(`Task "${taskId}" launch accepted by TaskRunner`, { module: 'exec' });
        },
        onLaunchStart: (taskId, executor) => {
          launchingTasks.add(taskId);
          logger.info(`Task "${taskId}" launch started (executor: ${executor.type})`, { module: 'exec' });
        },
        onLaunchFailed: (taskId, error, executor) => {
          launchingTasks.delete(taskId);
          logger.error(
            `Task "${taskId}" launch failed before spawn (executor: ${executor.type}): ${error.message}`,
            { module: 'exec' },
          );
        },
        onSpawned: (taskId, handle, executor) => {
          launchingTasks.delete(taskId);
          flushTaskOutput(taskId);
          logger.info(
            `Task "${taskId}" spawned (handle: ${handle.executionId}, executor: ${executor.type}, workspace: ${handle.workspacePath ?? 'none'}, branch: ${handle.branch ?? 'none'})`,
            { module: 'exec' },
          );
          taskHandles.set(taskId, { handle, executor });
        },
        onComplete: (taskId, response) => {
          flushTaskOutput(taskId);
          launchingTasks.delete(taskId);
          taskHandles.delete(taskId);
          logger.info(
            `Task "${taskId}" completion callback received (status: ${response.status}, generation: ${response.executionGeneration}, exitCode: ${response.outputs.exitCode ?? 'none'})`,
            { module: 'exec' },
          );
        },
        onHeartbeat: (taskId) => {
          const now = new Date();
          const task = orchestrator.getTask(taskId);
          const previousHeartbeat = task?.execution.lastHeartbeatAt instanceof Date
            ? task.execution.lastHeartbeatAt
            : task?.execution.lastHeartbeatAt
              ? new Date(task.execution.lastHeartbeatAt)
              : undefined;
          const heartbeatGapMs = previousHeartbeat ? now.getTime() - previousHeartbeat.getTime() : undefined;
          try { persistence.updateTask(taskId, { execution: { lastHeartbeatAt: now } }); } catch { /* db locked */ }
          messageBus.publish(Channels.TASK_DELTA, {
            type: 'updated' as const,
            taskId,
            changes: { execution: { lastHeartbeatAt: now } },
          });
          logger.info(
            `Heartbeat for "${taskId}" (status: ${task?.status ?? 'unknown'}, generation: ${task?.execution.generation ?? 'unknown'}, gapMs: ${heartbeatGapMs ?? 'first'})`,
            { module: 'heartbeat' },
          );
        },
        onLaunchSettled: (taskId) => {
          launchingTasks.delete(taskId);
        },
      },
    });
    wireApproveHook();
  }

  function wireApproveHook(): void {
    orchestrator.setBeforeApproveHook(async (task) => {
      if (task.config.isMergeNode && task.config.workflowId && task.execution.pendingFixError === undefined) {
        const workflow = persistence.loadWorkflow(task.config.workflowId);
        if (workflow?.mergeMode === "external_review") return; // external review is the merge mechanism
        await requireTaskExecutor().approveMerge(task.config.workflowId);
      }
    });
  }

  async function killRunningTask(taskId: string): Promise<void> {
    const entry = taskHandles.get(taskId);
    if (!entry) return;
    logger.info(`Killing running task "${taskId}" before restart`, { module: 'kill' });
    await entry.executor.kill(entry.handle);
    taskHandles.delete(taskId);
  }

  /** Cancel a task and cascade-kill all downstream DAG dependents. Shared by IPC, headless, and API. */
  async function performCancelTask(taskId: string): Promise<{ cancelled: string[]; runningCancelled: string[] }> {
    const envelope = makeEnvelope('cancel-task', 'ui', 'task', { taskId });
    const cmdResult = await commandService.cancelTask(envelope);
    if (!cmdResult.ok) throw CommandError.fromResult(cmdResult.error);
    for (const id of cmdResult.data.runningCancelled) {
      await killRunningTask(id);
    }
    return cmdResult.data;
  }

  /** Cancel all active tasks in a workflow and kill any running processes. */
  async function performCancelWorkflow(workflowId: string): Promise<{ cancelled: string[]; runningCancelled: string[] }> {
    logger.info(`performCancelWorkflow begin workflow="${workflowId}"`, { module: 'kill' });
    const envelope = makeEnvelope('cancel-workflow', 'ui', 'workflow', { workflowId });
    const cmdResult = await commandService.cancelWorkflow(envelope);
    if (!cmdResult.ok) throw CommandError.fromResult(cmdResult.error);
    logger.info(
      `performCancelWorkflow commandService complete workflow="${workflowId}" cancelled=${cmdResult.data.cancelled.length} runningCancelled=${cmdResult.data.runningCancelled.length}`,
      { module: 'kill' },
    );
    for (const id of cmdResult.data.runningCancelled) {
      logger.info(`performCancelWorkflow killing running task "${id}"`, { module: 'kill' });
      await killRunningTask(id);
    }
    logger.info(`performCancelWorkflow end workflow="${workflowId}"`, { module: 'kill' });
    return cmdResult.data;
  }

  async function performDeleteWorkflow(workflowId: string): Promise<void> {
    logger.info(`performDeleteWorkflow begin workflow="${workflowId}"`, { module: 'kill' });
    // Kill all running tasks belonging to the workflow (process management is outside orchestrator scope)
    const allTasks = orchestrator.getAllTasks();
    const workflowTasks = allTasks.filter(
      (t) =>
        t.config.workflowId === workflowId &&
        (t.status === 'running' || t.status === 'fixing_with_ai'),
    );
    for (const task of workflowTasks) {
      await killRunningTask(task.id);
    }
    // Serialized via CommandService: DB delete + memory clear + scheduler cleanup + removal deltas
    const envelope = makeEnvelope('delete-workflow', 'ui', 'workflow', { workflowId });
    const result = await commandService.deleteWorkflow(envelope);
    if (!result.ok) throw new Error(result.error.message);
    logger.info(`performDeleteWorkflow end workflow="${workflowId}"`, { module: 'kill' });
  }

  async function performDetachWorkflow(workflowId: string, upstreamWorkflowId: string): Promise<void> {
    logger.info(`performDetachWorkflow begin workflow="${workflowId}" upstream="${upstreamWorkflowId}"`, { module: 'kill' });
    const envelope = makeEnvelope('detach-workflow', 'ui', 'workflow', { workflowId, upstreamWorkflowId });
    const result = await commandService.detachWorkflow(envelope);
    if (!result.ok) throw new Error(result.error.message);
    logger.info(`performDetachWorkflow end workflow="${workflowId}" upstream="${upstreamWorkflowId}"`, { module: 'kill' });
  }

  /** Orchestrator error codes that preemption treats as benign (cancel is best-effort). */
  const preemptSkipCodes: ReadonlySet<string> = new Set([
    OrchestratorErrorCode.TASK_NOT_FOUND,
    OrchestratorErrorCode.TASK_ALREADY_TERMINAL,
    OrchestratorErrorCode.WORKFLOW_NOT_FOUND,
  ]);

  async function preemptTaskSubgraph(taskId: string): Promise<void> {
    try {
      await performCancelTask(taskId);
    } catch (err) {
      if (err instanceof CommandError && preemptSkipCodes.has(err.code)) {
        logger.info(`preemptTaskSubgraph skipped for "${taskId}": ${err.message}`, { module: 'ipc' });
        return;
      }
      throw err;
    }
  }

  async function preemptWorkflowExecution(workflowId: string): Promise<WorkflowCancelResult> {
    try {
      logger.info(`preemptWorkflowExecution begin for "${workflowId}"`, { module: 'ipc' });
      const result = await performCancelWorkflow(workflowId);
      logger.info(`preemptWorkflowExecution end for "${workflowId}"`, { module: 'ipc' });
      return result;
    } catch (err) {
      if (err instanceof CommandError && preemptSkipCodes.has(err.code)) {
        logger.info(`preemptWorkflowExecution skipped for "${workflowId}": ${err.message}`, { module: 'ipc' });
        return { cancelled: [], runningCancelled: [] };
      }
      throw err;
    }
  }

  function requireTaskExecutor(): TaskRunner {
    if (!taskExecutor) {
      throw new Error('Mutation execution is unavailable in read-only follower mode');
    }
    return taskExecutor;
  }

  async function executeHeadlessRun(payload: HeadlessRunMutationPayload): Promise<{ workflowId: string; tasks: TaskState[] }> {
    const { parsePlanFile } = await import('./plan-parser.js');
    const plan = await parsePlanFile(payload.planPath);
    taskHandles.clear();
    backupPlan(plan, undefined, logger);
    const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
    orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
    const workflowId = orchestrator.getWorkflowIds().find(id => !wfIdsBefore.has(id))!;
    const started = orchestrator.startExecution();
    requireTaskExecutor().executeTasks(started).catch(err => {
      logger.error(`headless.run: executeTasks failed for "${workflowId}": ${err}`, { module: 'ipc-delegate' });
    });
    logger.info(`started ${started.length} tasks for workflow "${workflowId}"`, { module: 'ipc-delegate' });
    const tasks = orchestrator.getAllTasks().filter(t => t.config.workflowId === workflowId);
    return { workflowId, tasks };
  }

  async function executeHeadlessResume(payload: HeadlessResumeMutationPayload): Promise<{ workflowId: string; tasks: TaskState[] }> {
    const { workflowId } = payload;
    orchestrator.syncFromDb(workflowId);

    const allStarted = relaunchOrphansAndStartReady(orchestrator, logger, 'ipc-delegate', workflowId);
    if (allStarted.length > 0) {
      requireTaskExecutor().executeTasks(allStarted).catch(err => {
        logger.error(`headless.resume: executeTasks failed for "${workflowId}": ${err}`, { module: 'ipc-delegate' });
      });
    }
    requireTaskExecutor().resumeMergeGatePolling();
    const tasks = orchestrator.getAllTasks().filter(t => t.config.workflowId === workflowId);
    return { workflowId, tasks };
  }

  async function executeHeadlessExec(payload: HeadlessExecMutationPayload): Promise<unknown> {
    logger.info(`executeHeadlessExec begin args="${payload.args.join(' ')}" noTrack=${payload.noTrack ? 'true' : 'false'}`, {
      module: 'ipc-delegate',
    });
    const headlessCommand = String(payload.args[0] ?? '');
    const headlessTarget = String(payload.args[1] ?? '');
    const resolvedHeadlessTarget = resolveHeadlessTarget(headlessTarget, persistence);
    if (
      (headlessCommand === 'recreate' || headlessCommand === 'retry')
      && resolvedHeadlessTarget.kind === 'workflow'
    ) {
      cancelDeferredWorkflowLaunch(resolvedHeadlessTarget.workflowId, `headless.${headlessCommand}`);
    }
    await runHeadless(payload.args, {
      logger,
      orchestrator, persistence, executorRegistry, messageBus,
      commandService,
      repoRoot, invokerConfig, initServices, wireSlackBot,
      signal: activeMutationContext?.signal,
      mutationTiming: activeMutationContext?.mutationTiming,
      cancelTask: (taskId: string) => performCancelTask(taskId),
      cancelWorkflow: (workflowId: string) => performCancelWorkflow(workflowId),
      waitForApproval: payload.waitForApproval,
      noTrack: payload.noTrack,
      preemptTaskSubgraph: (taskId: string) => preemptTaskSubgraph(taskId),
      preemptWorkflowExecution: (workflowId: string) => preemptWorkflowExecution(workflowId),
      deferRunnableTasks: (tasks: TaskState[], workflowId?: string) => {
        const filteredTasks = tasks;
        const crossWorkflowTasks = workflowId
          ? tasks.filter((task) => task.config.workflowId !== workflowId)
          : [];
        if (crossWorkflowTasks.length > 0) {
          logger.info(
            `deferRunnableTasks dispatching cross-workflow runnable tasks for workflow="${workflowId}": ${crossWorkflowTasks.map((task) => `${task.id}(${task.config.workflowId ?? 'unknown'})`).join(', ')}`,
            { module: 'ipc-delegate' },
          );
        }
        if (filteredTasks.length === 0) {
          return;
        }
        // Keep this path timer-based for now: it is a low-blast-radius, mutation-safe
        // way to decouple no-track command handling from heavy executor startup while
        // still coalescing rapid restarts. We are considering an RxJS/backpressure
        // scheduler refactor for richer queue semantics, but that is a broader design
        // change than this targeted starvation fix.
        const deferDelayMs = Number.parseInt(process.env.INVOKER_DEFER_RUNNABLE_DELAY_MS ?? '25', 10) || 25;
        const maxCoalesceMs = Number.parseInt(
          process.env.INVOKER_DEFER_RUNNABLE_MAX_COALESCE_MS ?? String(Math.max(1000, deferDelayMs)),
          10,
        ) || Math.max(1000, deferDelayMs);
        const launchKey = workflowId ?? filteredTasks.map((task) => task.id).sort().join('|');
        const existingLaunch = deferredWorkflowLaunches.get(launchKey);
        const nowMs = Date.now();
        const timing = computeDeferredLaunchTiming({
          existingFirstScheduledAtMs: existingLaunch?.firstScheduledAtMs,
          nowMs,
          deferDelayMs,
          maxCoalesceMs,
        });
        if (existingLaunch) {
          clearTimeout(existingLaunch.timer);
          logger.info(
            `deferRunnableTasks coalesce workflow="${workflowId ?? 'unknown'}" previousCount=${existingLaunch.taskIds.length} nextCount=${filteredTasks.length} delayMs=${timing.delayMs} maxCoalesceMs=${maxCoalesceMs}`,
            { module: 'ipc-delegate' },
          );
        }
        logger.info(
          `deferRunnableTasks schedule workflow="${workflowId ?? 'unknown'}" count=${filteredTasks.length} delayMs=${timing.delayMs} ids=${filteredTasks.map((task) => task.id).join(',')}`,
          { module: 'ipc-delegate' },
        );
        const launch = setTimeout(() => {
          deferredWorkflowLaunches.delete(launchKey);
          logger.info(
            `deferRunnableTasks start workflow="${workflowId ?? 'unknown'}" count=${filteredTasks.length}`,
            { module: 'ipc-delegate' },
          );
          remoteFetchForPool.enabled = false;
          void requireTaskExecutor().executeTasks(filteredTasks)
            .then(() => {
              logger.info(
                `deferRunnableTasks complete workflow="${workflowId ?? 'unknown'}" count=${filteredTasks.length}`,
                { module: 'ipc-delegate' },
              );
            })
            .catch((err) => {
              logger.error(
                `background delegated workflow execution failed for ${workflowId ?? filteredTasks.map((t) => t.id).join(', ')}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
                { module: 'ipc-delegate' },
              );
            })
            .finally(() => {
              remoteFetchForPool.enabled = true;
            });
        }, timing.delayMs);
        launch.unref?.();
        deferredWorkflowLaunches.set(launchKey, {
          timer: launch,
          taskIds: filteredTasks.map((task) => task.id),
          firstScheduledAtMs: timing.firstScheduledAtMs,
        });
      },
      executionAgentRegistry: registerBuiltinAgents(),
    });
    const { workflowId } = classifyHeadlessExecMutation(payload);
    logger.info(`executeHeadlessExec end args="${payload.args.join(' ')}" workflow="${workflowId ?? 'unknown'}"`, {
      module: 'ipc-delegate',
    });
    if (!workflowId) {
      return { ok: true };
    }
    orchestrator.syncFromDb(workflowId);
    const tasks = orchestrator.getAllTasks().filter((task) => task.config.workflowId === workflowId);
    return { workflowId, tasks };
  }

  function workflowIdForTargetArg(targetArg: unknown): string | undefined {
    if (targetArg === undefined) return undefined;
    return resolveHeadlessTargetWorkflowId(targetArg, persistence);
  }

  function workflowIdForTaskArg(taskIdArg: unknown): string | undefined {
    return workflowIdForTargetArg(taskIdArg);
  }

  function classifyHeadlessExecMutation(payload: HeadlessExecMutationPayload): {
    workflowId?: string;
    priority: WorkflowMutationPriority;
  } {
    const [command, arg0] = payload.args;
    if (!command) return { priority: 'normal' };

    switch (command) {
      case 'retry':
        return { workflowId: workflowIdForTaskArg(arg0), priority: 'high' };
      case 'recreate':
      case 'cancel-workflow':
      case 'delete':
      case 'delete-workflow':
        return { workflowId: arg0, priority: 'high' };
      case 'recreate-with-rebase':
        return { workflowId: workflowIdForTargetArg(arg0), priority: 'high' };
      case 'rebase':
      case 'cancel':
      case 'recreate-task':
        return { workflowId: workflowIdForTaskArg(arg0), priority: 'high' };
      case 'approve':
      case 'reject':
      case 'select':
      case 'fix':
      case 'resolve-conflict':
        return { workflowId: workflowIdForTaskArg(arg0), priority: 'normal' };
      default:
        return { priority: 'normal' };
    }
  }

  async function runWorkflowMutation<T>(
    workflowId: string | undefined,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
    op: () => Promise<T>,
  ): Promise<T> {
    if (!workflowId) return op();
    if (!workflowMutationCoordinator) {
      throw new Error('Workflow mutation coordinator is unavailable');
    }
    if (!workflowMutationDispatcher.has(channel)) {
      throw new Error(`No workflow mutation dispatcher registered for ${channel}`);
    }
    return workflowMutationCoordinator.enqueue<T>(workflowId, priority, channel, args);
  }

  function translateGuiMutationToHeadless(payload: GuiMutationPayload):
    | { channel: 'headless.run'; request: HeadlessRunMutationPayload }
    | { channel: 'headless.resume'; request: HeadlessResumeMutationPayload }
    | { channel: 'headless.exec'; request: HeadlessExecMutationPayload }
    | null {
    const [arg0, arg1, arg2] = payload.args;
    switch (payload.channel) {
      case 'invoker:stop':
        return { channel: 'headless.exec', request: { args: ['stop'] } };
      case 'invoker:clear':
        return { channel: 'headless.exec', request: { args: ['clear'] } };
      case 'invoker:resume-workflow': {
        const workflows = persistence.listWorkflows();
        const workflowId = workflows[0]?.id;
        if (!workflowId) return null;
        return { channel: 'headless.resume', request: { workflowId } };
      }
      case 'invoker:delete-all-workflows':
        return { channel: 'headless.exec', request: { args: ['delete-all'] } };
      case 'invoker:delete-all-workflows-bulk':
        return { channel: 'headless.exec', request: { args: ['delete-all'] } };
      case 'invoker:delete-workflow':
        return { channel: 'headless.exec', request: { args: ['delete', String(arg0)] } };
      case 'invoker:detach-workflow':
        return { channel: 'headless.exec', request: { args: ['detach-workflow', String(arg0), String(arg1)] } };
      case 'invoker:provide-input':
        return { channel: 'headless.exec', request: { args: ['input', String(arg0), String(arg1)] } };
      case 'invoker:approve':
        return { channel: 'headless.exec', request: { args: ['approve', String(arg0)] } };
      case 'invoker:reject':
        return arg1 === undefined
          ? { channel: 'headless.exec', request: { args: ['reject', String(arg0)] } }
          : { channel: 'headless.exec', request: { args: ['reject', String(arg0), String(arg1)] } };
      case 'invoker:select-experiment':
        if (Array.isArray(arg1)) return null;
        return { channel: 'headless.exec', request: { args: ['select', String(arg0), String(arg1)] } };
      case 'invoker:restart-task':
        return { channel: 'headless.exec', request: { args: ['retry-task', String(arg0)] } };
      case 'invoker:cancel-task':
        return { channel: 'headless.exec', request: { args: ['cancel', String(arg0)] } };
      case 'invoker:cancel-workflow':
        return { channel: 'headless.exec', request: { args: ['cancel-workflow', String(arg0)] } };
      case 'invoker:recreate-workflow':
        return { channel: 'headless.exec', request: { args: ['recreate', String(arg0)] } };
      case 'invoker:recreate-task':
        return { channel: 'headless.exec', request: { args: ['recreate-task', String(arg0)] } };
      case 'invoker:retry-workflow':
        return { channel: 'headless.exec', request: { args: ['retry', String(arg0)] } };
      case 'invoker:rebase-and-retry':
        return { channel: 'headless.exec', request: { args: ['rebase', String(arg0)] } };
      case 'invoker:recreate-with-rebase':
        return { channel: 'headless.exec', request: { args: ['recreate-with-rebase', String(arg0)] } };
      case 'invoker:set-merge-mode':
        return { channel: 'headless.exec', request: { args: ['set', 'merge-mode', String(arg0), String(arg1)] } };
      case 'invoker:approve-merge': {
        const workflowId = String(arg0);
        const mergeTask = persistence.loadTasks(workflowId).find((task) => task.config.isMergeNode);
        if (!mergeTask) return null;
        return { channel: 'headless.exec', request: { args: ['approve', mergeTask.id] } };
      }
      case 'invoker:resolve-conflict':
        return arg1 === undefined
          ? { channel: 'headless.exec', request: { args: ['resolve-conflict', String(arg0)] } }
          : { channel: 'headless.exec', request: { args: ['resolve-conflict', String(arg0), String(arg1)] } };
      case 'invoker:fix-with-agent':
        return arg1 === undefined
          ? { channel: 'headless.exec', request: { args: ['fix', String(arg0)] } }
          : { channel: 'headless.exec', request: { args: ['fix', String(arg0), String(arg1)] } };
      case 'invoker:edit-task-command':
        return { channel: 'headless.exec', request: { args: ['set', 'command', String(arg0), String(arg1)] } };
      case 'invoker:edit-task-prompt':
        return { channel: 'headless.exec', request: { args: ['set', 'prompt', String(arg0), String(arg1)] } };
      case 'invoker:edit-task-type':
        return { channel: 'headless.exec', request: { args: ['set', 'executor', String(arg0), String(arg1)] } };
      case 'invoker:edit-task-pool':
        return null;
      case 'invoker:edit-task-agent':
        return { channel: 'headless.exec', request: { args: ['set', 'agent', String(arg0), String(arg1)] } };
      case 'invoker:set-task-external-gate-policies': {
        const taskId = String(arg0);
        const updates = Array.isArray(arg1) ? arg1 as Array<{ workflowId: string; taskId?: string; gatePolicy: 'completed' | 'review_ready' }> : [];
        if (updates.length !== 1) return null;
        const update = updates[0];
        if (!update) return null;
        const args = ['set', 'gate-policy', taskId, update.workflowId];
        if (update.taskId) args.push(update.taskId);
        args.push(update.gatePolicy);
        return { channel: 'headless.exec', request: { args } };
      }
      case 'invoker:replace-task':
        return {
          channel: 'headless.exec',
          request: { args: ['replace-task', String(arg0), JSON.stringify(Array.isArray(arg1) ? arg1 : [])] },
        };
      default:
        return null;
    }
  }

  async function performSharedApproveTask(
    taskId: string,
    source: 'ui' | 'surface' | 'api',
    scope: 'task' | 'workflow' = 'task',
  ): Promise<{ started: TaskState[] }> {
    const envelope = makeEnvelope('approve', source === 'api' ? 'surface' : source, scope, { taskId });
    return sharedApproveTask(taskId, {
      orchestrator,
      taskExecutor: requireTaskExecutor(),
      approve: async (approvedTaskId) => {
        const result = await commandService.approve({ ...envelope, payload: { taskId: approvedTaskId } });
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
      resumeAfterFixApproval: async (approvedTaskId) => {
        const result = await commandService.resumeTaskAfterFixApproval({ ...envelope, payload: { taskId: approvedTaskId } });
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      },
    });
  }

  function registerGuiMutationHandler<TResult = unknown>(
    channel: string,
    handler: (...args: unknown[]) => Promise<TResult>,
  ): void {
    guiMutationHandlers.set(channel, handler as (...args: unknown[]) => Promise<unknown>);
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      if (ownerMode) {
        return handler(...args);
      }
      const translated = translateGuiMutationToHeadless({ channel, args });
      if (!translated) {
        throw new Error(`No owner delegation route is available for ${channel}`);
      }
      try {
        return await messageBus.request<typeof translated.request, TResult>(translated.channel, translated.request);
      } catch (err) {
        if (err instanceof TransportError && err.code === TransportErrorCode.NO_HANDLER) {
          throw new Error('No mutation owner is available');
        }
        throw err;
      }
    });
  }

  function registerWorkflowScopedGuiMutationHandler<TResult = unknown>(
    channel: string,
    resolveWorkflowId: (...args: unknown[]) => string | undefined,
    priority: WorkflowMutationPriority,
    handler: (...args: unknown[]) => Promise<TResult>,
  ): void {
    workflowMutationDispatcher.set(channel, (...args: unknown[]) => handler(...args));
    registerGuiMutationHandler(channel, async (...args: unknown[]) => {
      const workflowId = resolveWorkflowId(...args);
      return runWorkflowMutation(workflowId, priority, channel, args, () => handler(...args));
    });
  }

  function createWindow(): void {
    recordStartupMark('createWindow.begin');
    const iconPath = path.join(__dirname, 'assets', 'icons', 'png', '256x256.png');
    const icon = nativeImage.createFromPath(iconPath);
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      // Show explicitly after load/timeout rather than relying on Electron's
      // implicit initial map behavior, which has regressed on some Linux/X11
      // sessions and leaves the BrowserWindow unmapped.
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
      icon: !icon.isEmpty() && process.platform !== 'darwin' ? icon : undefined,
      title: 'Invoker',
    });

    // BrowserWindow icons matter on Windows/Linux. macOS uses the bundle icon.
    if (process.platform !== 'darwin') {
      if (!icon.isEmpty()) mainWindow.setIcon(icon);
    }

    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      mainWindow.loadURL(devUrl);
    } else {
      const packagedUiPath = path.join(__dirname, 'ui', 'index.html');
      const repoUiPath = path.join(__dirname, '..', '..', 'ui', 'dist', 'index.html');
      const uiDistPath = existsSync(packagedUiPath) ? packagedUiPath : repoUiPath;
      mainWindow.loadFile(uiDistPath).catch(() => {
        mainWindow?.loadURL(
          `data:text/html,<html><body style="background:#1a1a2e;color:#eee;font-family:system-ui;padding:2rem"><h1>Invoker</h1><p>UI not built yet. Run: <code>pnpm --filter @invoker/ui build</code></p></body></html>`,
        );
      });
    }

    mainWindow.webContents.on('did-finish-load', () => {
      logger.info('main window did-finish-load', { module: 'window' });
      recordStartupMark('window.did-finish-load');
    });

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      logger.error(
        `main window did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`,
        { module: 'window' },
      );
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      logger.error(
        `main window render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`,
        { module: 'window' },
      );
    });

    const shouldShowWindow = process.env.NODE_ENV !== 'test' || enableTestCompositor;
    if (shouldShowWindow) {
      let showTriggered = false;
      const showWindow = (): void => {
        if (!mainWindow || mainWindow.isDestroyed() || showTriggered) return;
        showTriggered = true;
        logger.info('main window show()', { module: 'window' });
        recordStartupMark('window.show');
        mainWindow.show();
        mainWindow.focus();
        uiInteractive = true;
        recordStartupMark('ui.interactive');
        startDeferredStartupWork();
      };

      mainWindow.once('ready-to-show', showWindow);
      setTimeout(showWindow, 1500).unref?.();
    } else {
      uiInteractive = true;
      recordStartupMark('ui.interactive');
      startDeferredStartupWork();
    }

    mainWindow.on('closed', () => {
      logger.info('main window closed', { module: 'window' });
      mainWindow = null;
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) {
        const browserCmd = invokerConfig.browser;
        if (browserCmd) {
          spawn(browserCmd, [url], { detached: true, stdio: 'ignore' }).unref();
        } else {
          const chromeCmd: [string, string[]] = process.platform === 'darwin'
            ? ['open', ['-a', 'Google Chrome', url]]
            : process.platform === 'win32'
              ? ['cmd', ['/c', 'start', 'chrome', url]]
              : ['google-chrome', [url]];
          try {
            spawn(chromeCmd[0], chromeCmd[1], { detached: true, stdio: 'ignore' }).unref();
          } catch {
            shell.openExternal(url);
          }
        }
      }
      return { action: 'deny' as const };
    });
  }

  function seedUiSnapshotCache(): void {
    lastKnownWorkflowCount = persistence.listWorkflows().length;
    lastKnownTaskStates.clear();
    for (const task of orchestrator.getAllTasks()) {
      lastKnownTaskStates.set(task.id, JSON.stringify(task));
    }
  }

  function loadTaskByIdFromPersistence(taskId: string): TaskState | undefined {
    return persistence.loadTask(taskId);
  }

  workflowMetadataInvalidator = new WorkflowMetadataInvalidator({
    getCachedTaskSnapshot: (taskId) => lastKnownTaskStates.get(taskId),
    loadTask: loadTaskByIdFromPersistence,
    listWorkflows: () => persistence.listWorkflows(),
    publish: (workflows) => {
      lastKnownWorkflowCount = workflows.length;
      if (!mainWindow || mainWindow.isDestroyed() || !uiInteractive) {
        return;
      }
      mainWindow.webContents.send('invoker:workflows-changed', workflows);
    },
  });

  function listWorkflowsByStartupRecency() {
    const workflows = timeStartupPhase('listWorkflowsByStartupRecency', () => persistence.listWorkflows(), (result) => ({
      workflowCount: result.length,
    }));
    return [...workflows].sort((left, right) => {
      const rightTs = Date.parse(right.updatedAt ?? '') || 0;
      const leftTs = Date.parse(left.updatedAt ?? '') || 0;
      if (rightTs !== leftTs) {
        return rightTs - leftTs;
      }
      return right.createdAt.localeCompare(left.createdAt);
    });
  }

  function bootstrapInitialWorkflowState(): void {
    const workflows = listWorkflowsByStartupRecency();
    lastKnownWorkflowCount = workflows.length;
    startupWorkflowId = workflows[0]?.id ?? null;
    if (!startupWorkflowId) {
      logger.info('[init] No workflows available for initial startup bootstrap', { module: 'init' });
      return;
    }
    try {
      timeStartupPhase('orchestrator.restore.full-snapshot', () => orchestrator.syncAllFromDb(), () => ({
        workflowCount: workflows.length,
        taskCount: orchestrator.getAllTasks().length,
      }));
      const snapshotStats = (persistence as unknown as {
        getLastWorkflowTaskSnapshotStats?: () => Record<string, unknown> | null;
      }).getLastWorkflowTaskSnapshotStats?.();
      if (snapshotStats) {
        recordStartupDetail('sqlite.workflow-metadata.query', {
          durationMs: snapshotStats.workflowMetadataQueryMs,
          workflowCount: snapshotStats.workflowCount,
        });
        recordStartupDetail('sqlite.tasks.query', {
          durationMs: snapshotStats.taskQueryMs,
          taskCount: snapshotStats.taskCount,
        });
        recordStartupDetail('sqlite.workflow-rollups.compute', {
          durationMs: snapshotStats.rollupComputationMs,
          workflowCount: snapshotStats.workflowCount,
          taskCount: snapshotStats.taskCount,
        });
        recordStartupDetail('sqlite.tasks.deserialize-reconcile', {
          durationMs: snapshotStats.taskDeserializeReconcileMs,
          taskCount: snapshotStats.taskCount,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`workflow invariant violation during full startup bootstrap: ${message}`, {
        module: 'init',
        error: message,
      });
      throw err;
    }
    logger.info(
      `[init] Bootstrapped full workflow graph with ${orchestrator.getAllTasks().length} tasks across ${workflows.length} workflows`,
      { module: 'init' },
    );
    recordStartupMark('startup.full-graph.ready', {
      workflowId: startupWorkflowId,
      taskCount: orchestrator.getAllTasks().length,
      workflowCount: workflows.length,
    });
  }

  function publishOrchestratorSnapshotToRenderer(): void {
    const workflows = persistence.listWorkflows();
    const tasks = orchestrator.getAllTasks();
    const previousTaskIds = new Set(lastKnownTaskStates.keys());
    lastKnownTaskStates.clear();
    for (const task of tasks) {
      const snapshot = JSON.stringify(task);
      previousTaskIds.delete(task.id);
      lastKnownTaskStates.set(task.id, snapshot);
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendTaskDeltaToRenderer({ type: 'created', task });
      }
    }
    lastKnownWorkflowCount = workflows.length;
    if (mainWindow && !mainWindow.isDestroyed()) {
      for (const removedTaskId of previousTaskIds) {
        sendTaskDeltaToRenderer({ type: 'removed', taskId: removedTaskId, previousTaskStateVersion: 0 });
      }
      mainWindow.webContents.send('invoker:workflows-changed', workflows);
    }
  }

  function startDeferredStartupWork(): void {
    if (deferredStartupTriggered) return;
    deferredStartupTriggered = true;
    recordStartupMark('deferred-startup.begin');
    const startupPollDelayMs = Number.parseInt(process.env.INVOKER_STARTUP_POLL_DELAY_MS ?? '10000', 10) || 10000;

    setTimeout(() => {
      if (!ownerMode) return;

      apiServer = startApiServer({
        logger,
        orchestrator,
        persistence,
        executorRegistry,
        mutations: new WorkflowMutationFacade({
          logger,
          orchestrator,
          persistence,
          taskExecutor: requireTaskExecutor(),
          autoApproveAIFixes: invokerConfig.autoApproveAIFixes,
          killRunningTask,
        }),
        deleteWorkflow: performDeleteWorkflow,
        detachWorkflow: performDetachWorkflow,
      });
      recordStartupMark('api-server.started');

      void recoverWorkflowMutationsOnStartup({
        ownerMode,
        persistence,
        workflowMutationCoordinator: workflowMutationCoordinator ?? undefined,
        logger,
        maybeDelayResume: maybeDelayWorkflowResumeForTest,
      });

      startSlackBot(requireTaskExecutor(), taskHandles).catch((err) => {
        logger.info(`Not started: ${err instanceof Error ? err.message : String(err)}`, { module: 'slack' });
      });

      setTimeout(() => {
        dbPollInterval = setInterval(() => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          try {
            const workflows = persistence.listWorkflows();

            if (workflows.length !== lastKnownWorkflowCount) {
              const msg = `Workflow count changed: ${lastKnownWorkflowCount} → ${workflows.length}`;
              logger.info(msg, { module: 'db-poll' });
              try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
              lastKnownWorkflowCount = workflows.length;
              mainWindow.webContents.send('invoker:workflows-changed', workflows);

              orchestrator.syncAllFromDb();
              logger.info(`Synced orchestrator for all ${workflows.length} workflows`, { module: 'db-poll' });
            }

            for (const wf of workflows) {
              if (wf.status === 'completed' || wf.status === 'failed') continue;
              const tasks = persistence.loadTasks(wf.id);
              for (const loadedTask of tasks) {
                let task = loadedTask;
                const now = new Date();
                const previousHeartbeat = parseExecutionDate(task.execution.lastHeartbeatAt);
                const selectedAttempt = task.execution.selectedAttemptId
                  ? persistence.loadAttempt?.(task.execution.selectedAttemptId)
                  : undefined;
                const leaseExpiresAt = parseExecutionDate(selectedAttempt?.leaseExpiresAt);
                const remoteHeartbeat = parseExecutionDate(task.execution.remoteHeartbeatAt);

                if (task.status === 'running' || (task.status === 'pending' && task.execution.phase === 'launching')) {
                  const launchStartedAt = parseExecutionDate(task.execution.launchStartedAt)
                    ?? parseExecutionDate(task.execution.startedAt);
                  const launchStall = evaluateLaunchStall({
                    now,
                    status: task.status,
                    phase: task.execution.phase,
                    launchStartedAt,
                    selectedAttempt,
                    hasExecutionHandle: taskHandles.has(task.id),
                    isKnownLaunching: launchingTasks.has(task.id),
                    launchingStallTimeoutMs,
                  });
                  const { launchAgeMs, launchStalled } = launchStall;
                  if (launchStalled) {
                    const launchError =
                      `Launch stalled: task remained in running/launching for ${Math.floor(launchingStallTimeoutMs / 1000)}s without a spawned execution handle`;
                    logger.info(
                      `[launch-stall] detected task="${task.id}" phase=${task.execution.phase} launchAgeMs=${launchAgeMs} handlePresent=false`,
                      { module: 'db-poll' },
                    );
                    const failedResponse: WorkResponse = {
                      requestId: `launch-stall-${task.id}-${now.getTime()}`,
                      actionId: task.id,
                      attemptId: task.execution.selectedAttemptId,
                      executionGeneration: task.execution.generation ?? 0,
                      status: 'failed',
                      outputs: {
                        exitCode: 1,
                        error: launchError,
                      },
                    };
                    logger.error(`[launch-stall] forcing failure for "${task.id}": ${launchError}`, { module: 'db-poll' });
                    const startedAfterFailure = orchestrator.handleWorkerResponse(failedResponse);
                    const runnableAfterFailure = startedAfterFailure.filter(isDispatchableLaunch);
                    if (runnableAfterFailure.length > 0) {
                      logger.info(
                        `[launch-stall] dispatching ${runnableAfterFailure.length} task(s) started after failing "${task.id}"`,
                        { module: 'db-poll' },
                      );
                      void requireTaskExecutor().executeTasks(runnableAfterFailure).catch((err) => {
                        logger.error(`[launch-stall] executeTasks failed after failing "${task.id}": ${err instanceof Error ? err.stack ?? err.message : String(err)}`, { module: 'db-poll' });
                      });
                    }
                    continue;
                  }

                  const executingStartedAt = parseExecutionDate(task.execution.startedAt);
                  const executingAgeMs = executingStartedAt ? now.getTime() - executingStartedAt.getTime() : 0;
                  const { heartbeatStale, leaseExpired, executingStalled, staleReason } = evaluateExecutingStall({
                    now,
                    phase: task.execution.phase,
                    runnerKind: task.config.runnerKind,
                    executingStartedAt,
                    leaseExpiresAt,
                    executorHeartbeatAt: previousHeartbeat,
                    remoteHeartbeatAt: remoteHeartbeat,
                    executingStallTimeoutMs,
                  });

                  if (executingStalled) {
                    const executingError =
                      `Execution stalled: task remained in running/executing for ${Math.floor(executingAgeMs / 1000)}s ` +
                      `without a live execution handle and no completion signal from executor (${staleReason}).`;
                    logger.info(
                      `[executing-stall] detected task="${task.id}" phase=${task.execution.phase} executingAgeMs=${executingAgeMs} ` +
                        `handlePresent=${taskHandles.has(task.id)} leaseExpired=${leaseExpired} heartbeatStale=${heartbeatStale}`,
                      { module: 'db-poll' },
                    );
                    const failedResponse: WorkResponse = {
                      requestId: `executing-stall-${task.id}-${now.getTime()}`,
                      actionId: task.id,
                      attemptId: task.execution.selectedAttemptId,
                      executionGeneration: task.execution.generation ?? 0,
                      status: 'failed',
                      outputs: {
                        exitCode: 1,
                        error: executingError,
                      },
                    };
                    logger.error(`[executing-stall] forcing failure for "${task.id}": ${executingError}`, { module: 'db-poll' });
                    const startedAfterFailure = orchestrator.handleWorkerResponse(failedResponse);
                    const runnableAfterFailure = startedAfterFailure.filter(isDispatchableLaunch);
                    if (runnableAfterFailure.length > 0) {
                      logger.info(
                        `[executing-stall] dispatching ${runnableAfterFailure.length} task(s) started after failing "${task.id}"`,
                        { module: 'db-poll' },
                      );
                      void requireTaskExecutor().executeTasks(runnableAfterFailure).catch((err) => {
                        logger.error(
                          `[executing-stall] executeTasks failed after failing "${task.id}": ` +
                            `${err instanceof Error ? err.stack ?? err.message : String(err)}`,
                          { module: 'db-poll' },
                        );
                      });
                    }
                    continue;
                  }
                }

                const snapshot = JSON.stringify(task);
                const prev = lastKnownTaskStates.get(task.id);
                if (!prev) {
                  if (traceDbPollPerTask) {
                    const msg = `New task: ${task.id} (${task.status})`;
                    logger.info(msg, { module: 'db-poll' });
                    try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
                  }
                  lastKnownTaskStates.set(task.id, snapshot);
                  uiPerfStats.dbPollCreated += 1;
                  sendTaskDeltaToRenderer({ type: 'created', task });
                } else if (prev !== snapshot) {
                  if (traceDbPollPerTask) {
                    const msg = `Task updated: ${task.id} (${task.status})`;
                    logger.info(msg, { module: 'db-poll' });
                    try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
                  }
                  lastKnownTaskStates.set(task.id, snapshot);
                  uiPerfStats.dbPollUpdatedAsCreated += 1;
                  sendTaskDeltaToRenderer({ type: 'created', task });
                }
              }
            }
          } catch {
            // DB might be locked — skip this tick
          }
        }, 2000);

        activityPollInterval = setInterval(() => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          try {
            const entries = persistence.getActivityLogs(lastActivityLogId);
            if (entries.length > 0) {
              lastActivityLogId = entries[entries.length - 1].id;
              mainWindow.webContents.send('invoker:activity-log', entries);
            }
          } catch {
            // DB might be locked — skip this tick
          }
        }, 2000);
      }, startupPollDelayMs).unref?.();
    }, 0);
  }

  app.whenReady().then(async () => {
    recordStartupMark('app.whenReady');
    ownerMode = true;
    try {
      recordStartupMark('initServices.start');
      await initServices({ executionAgentRegistry: agentRegistry, startupSyncMode: 'none' });
      recordStartupMark('initServices.end', { ownerMode: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('[db-writer-lock]')) {
        process.stderr.write(`${RED}Error:${RESET} ${message}\n`);
        app.quit();
        return;
      }
      recordStartupMark('initServices.readOnly.start');
      await initServices({ readOnly: true, executionAgentRegistry: agentRegistry, startupSyncMode: 'none' });
      ownerMode = false;
      recordStartupMark('initServices.readOnly.end', { ownerMode: false });
    }

    if (ownerMode) {
      rebuildTaskRunner();
      workflowMutationCoordinator = new PersistedWorkflowMutationCoordinator(
        persistence,
        workflowMutationOwnerId,
        async (channel: string, args: unknown[], context) => {
          const handler = workflowMutationDispatcher.get(channel);
          if (!handler) {
            throw new Error(`No workflow mutation dispatcher registered for ${channel}`);
          }
          activeMutationContext = context;
          try {
            return await handler(...args);
          } finally {
            activeMutationContext = undefined;
          }
        },
        { logger },
      );
    } else {
      logger.info('Launched in follower mode; mutation execution is delegated to the current owner', {
        module: 'init',
      });
    }

    // ── IPC Delegation Handlers — peer → owner ────────────────
    // Peer processes delegate write-heavy commands to the owner process via IpcBus.
    if (ownerMode) {
      workflowMutationDispatcher.set('headless.exec', async (payloadArg: unknown) => {
        return executeHeadlessExec(payloadArg as HeadlessExecMutationPayload);
      });
      workflowMutationDispatcher.set('api:approve-task', async (taskIdArg: unknown) => {
        await performSharedApproveTask(String(taskIdArg), 'api');
      });
      workflowMutationDispatcher.set('api:reject-task', async (taskIdArg: unknown, reasonArg?: unknown) => {
        const taskId = String(taskIdArg);
        const reason = reasonArg === undefined ? undefined : String(reasonArg);
        const envelope = makeEnvelope('reject', 'surface', 'task', { taskId, reason });
        const result = await commandService.reject(envelope);
        if (!result.ok) throw new Error(result.error.message);
      });
      workflowMutationDispatcher.set('surface:approve-task', async (taskIdArg: unknown) => {
        await performSharedApproveTask(String(taskIdArg), 'surface');
      });
      messageBus.onRequest('headless.owner-ping', async () => ({
        ok: true,
        ownerId: workflowMutationOwnerId,
        mode: 'gui',
      }));
      messageBus.onRequest('headless.query', async (req: unknown) => {
        const { kind, reset } = req as { kind?: string; reset?: boolean };
        if (kind === 'ui-perf') {
          if (reset) {
            resetUiPerfStats();
          }
          return {
            ownerMode: 'gui',
            ...getUiPerfStats(),
          };
        }
        if (kind === 'queue') {
          return orchestrator.getQueueStatus() as unknown as Record<string, unknown>;
        }
        throw new Error(`Unsupported headless query: ${String(kind)}`);
      });
      messageBus.onRequest('headless.run', async (req: unknown) => {
        const { planPath, traceId } = req as { planPath: string; traceId?: string };
        logger.info(
          `headless.run received trace=${traceId ?? '<none>'} planPath="${planPath}" ownerId=${workflowMutationOwnerId} mode=gui`,
          { module: 'ipc-delegate' },
        );
        const result = await executeHeadlessRun({ planPath });
        logger.info(
          `headless.run accepted trace=${traceId ?? '<none>'} workflow="${result.workflowId}" tasks=${result.tasks.length} mode=gui`,
          { module: 'ipc-delegate' },
        );
        return result;
      });

      messageBus.onRequest('headless.resume', async (req: unknown) => {
        const { workflowId, traceId } = req as { workflowId: string; traceId?: string };
        logger.info(
          `headless.resume received trace=${traceId ?? '<none>'} workflowId="${workflowId}" ownerId=${workflowMutationOwnerId} mode=gui`,
          { module: 'ipc-delegate' },
        );
        const result = await executeHeadlessResume({ workflowId });
        logger.info(
          `headless.resume accepted trace=${traceId ?? '<none>'} workflow="${result.workflowId}" tasks=${result.tasks.length} mode=gui`,
          { module: 'ipc-delegate' },
        );
        return result;
      });

      messageBus.onRequest('headless.exec', async (req: unknown) => {
        const { args, waitForApproval: delegatedWait, noTrack: delegatedNoTrack, traceId } =
          req as { args: string[]; waitForApproval?: boolean; noTrack?: boolean; traceId?: string };
        if (!Array.isArray(args) || args.length === 0) {
          throw new Error('Missing delegated headless command arguments');
        }
        logger.info(
          `headless.exec received trace=${traceId ?? '<none>'} args="${args.join(' ')}" ownerId=${workflowMutationOwnerId} mode=gui`,
          { module: 'ipc-delegate' },
        );
        const payload: HeadlessExecMutationPayload = {
          args,
          waitForApproval: delegatedWait,
          noTrack: delegatedNoTrack,
          traceId,
        };
        const { workflowId, priority } = classifyHeadlessExecMutation(payload);
        if (delegatedNoTrack && workflowId && workflowMutationCoordinator) {
          const intentId = workflowMutationCoordinator.submit(workflowId, priority, 'headless.exec', [payload], {
            deferDrain: true,
          });
          logger.info(
            `headless.exec accepted trace=${traceId ?? '<none>'} workflow="${workflowId}" intent=${intentId} noTrack=true priority=${priority} mode=gui`,
            { module: 'ipc-delegate' },
          );
          return { ok: true, intentId };
        }
        return runWorkflowMutation(workflowId, priority, 'headless.exec', [payload], async () => executeHeadlessExec(payload));
      });
      logger.info(`owner-ipc-ready ownerId=${workflowMutationOwnerId}`, { module: 'ipc-delegate' });
      recordStartupMark('owner-ipc-ready');
    }

    bootstrapInitialWorkflowState();

    // Relaunch orphaned running tasks and start any pending-but-ready tasks.
    if (!ownerMode) {
      logger.info('follower mode startup: auto-run and orphan relaunch disabled', { module: 'init' });
    } else if (invokerConfig.disableAutoRunOnStartup) {
      logger.info('auto-run on startup disabled by config — skipping orphan relaunch', { module: 'init' });
    } else {
      const allStarted = relaunchOrphansAndStartReady(orchestrator, logger, 'init');
      if (allStarted.length > 0) {
        requireTaskExecutor().executeTasks(allStarted);
      }
      requireTaskExecutor().resumeMergeGatePolling();
    }

    const dbPath = path.join(resolveInvokerHomeRoot(), 'invoker.db');
    logger.info(`Database: ${dbPath}`, { module: 'init' });
    logger.info(`Repo root: ${repoRoot}`, { module: 'init' });
    logger.info(`Config: disableAutoRunOnStartup=${invokerConfig.disableAutoRunOnStartup ?? false}`, { module: 'init' });
    logger.info('Effective configuration', { config: getSafeInvokerConfigForLogging(invokerConfig), module: 'startup' });
    recordStartupMark('startup.ready-for-window');

    // Forward deltas to renderer and keep snapshot cache in sync so
    // the db-poll doesn't re-emit deltas the messageBus already delivered.
    messageBus.subscribe(Channels.TASK_DELTA, (delta: unknown) => {
      uiPerfStats.mainDeltaToUi += 1;
      if (traceUiDeltaFlow) {
        logger.debug(`delta→ui: ${JSON.stringify(delta)}`, { module: 'ui' });
      }
      sendTaskDeltaToRenderer(delta as TaskDelta);

      const d = delta as TaskDelta;
      const { quarantined } = applyDelta(d, lastKnownTaskStates);
      for (const taskId of quarantined) {
        logger.info(`[gap-detect] quarantined task="${taskId}" — triggering authoritative reload`, { module: 'delta-merge' });
        const authoritative = loadTaskByIdFromPersistence(taskId);
        resolveQuarantine(lastKnownTaskStates, taskId, authoritative);
        if (authoritative) {
          sendTaskDeltaToRenderer({ type: 'created', task: authoritative });
        }
      }
    });

    uiPerfLogInterval = setInterval(() => {
      const snapshot = {
        ts: new Date().toISOString(),
        metric: 'main_delta_flow',
        ...uiPerfStats,
      };
      try {
        persistence.writeActivityLog('ui-perf-main', 'info', JSON.stringify(snapshot));
      } catch {
        // DB might be locked
      }
    }, 10000);

    messageBus.subscribe(Channels.TASK_OUTPUT, (data: unknown) => {
      if (mainWindow && !mainWindow.isDestroyed() && uiInteractive) {
        mainWindow.webContents.send('invoker:task-output', data);
      }
    });

    // Register IPC handlers
    ipcMain.on('invoker:get-bootstrap-state-sync', (event) => {
      const startedAtMs = Date.now();
      const tasks = orchestrator.getAllTasks();
      const workflows = listWorkflowsByStartupRecency();
      const payload = {
        tasks,
        workflows,
        initialWorkflowId: startupWorkflowId,
        appStartedAtEpochMs: appProcessStartedAt,
      };
      const jsonSizeBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      recordStartupDuration('bootstrap-ipc.serialize-return', startedAtMs, {
        taskCount: tasks.length,
        workflowCount: workflows.length,
        jsonSizeBytes,
      });
      event.returnValue = payload;
    });
    registerGuiMutationHandler('invoker:load-plan', async (planTextArg: unknown) => {
      const planText = String(planTextArg);
      const { parsePlan } = await import('./plan-parser.js');
      const plan = parsePlan(planText);
      logger.info(`load-plan: "${plan.name}" (${plan.tasks.length} tasks)`, { module: 'ipc' });
      taskHandles.clear();
      backupPlan(plan, undefined, logger);
      orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
    });

    if (process.env.NODE_ENV === 'test') {
      ipcMain.handle(
        'invoker:inject-task-states',
        async (_event, updates: Array<{ taskId: string; changes: TaskStateChanges }>) => {
          for (const { taskId, changes } of updates) {
            const before = orchestrator.getTask(taskId);
            const previousSnapshot = lastKnownTaskStates.get(taskId);
            const previousTaskStateVersion = previousSnapshot
              ? (
                  (JSON.parse(previousSnapshot) as { taskStateVersion?: number }).taskStateVersion
                  ?? before?.taskStateVersion
                  ?? 1
                )
              : (before?.taskStateVersion ?? 0);
            persistence.updateTask(taskId, changes);
            messageBus.publish(Channels.TASK_DELTA, {
              type: 'updated',
              taskId,
              changes,
              previousTaskStateVersion,
              taskStateVersion: previousTaskStateVersion + 1,
            } satisfies TaskDelta);
          }
          orchestrator.syncAllFromDb();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('invoker:workflows-changed', persistence.listWorkflows());
          }
        },
      );
    }

    registerGuiMutationHandler('invoker:start', async () => {
      logger.info('start', { module: 'ipc' });
      const started = orchestrator.startExecution();
      logger.info(`startExecution returned ${started.length} tasks: [${started.map(t => t.id).join(', ')}]`, { module: 'ipc' });
      await requireTaskExecutor().executeTasks(started);
      return started;
    });

    registerGuiMutationHandler('invoker:resume-workflow', async () => {
      const workflows = persistence.listWorkflows();
      if (workflows.length === 0) {
        logger.info('resume-workflow: no workflows found', { module: 'ipc' });
        return null;
      }
      orchestrator.syncAllFromDb();

      const allStarted = relaunchOrphansAndStartReady(orchestrator, logger, 'resume-workflow');
      const tasks = orchestrator.getAllTasks();
      for (const task of tasks) {
        lastKnownTaskStates.set(task.id, JSON.stringify(task));
        if (mainWindow && !mainWindow.isDestroyed()) {
          sendTaskDeltaToRenderer({ type: 'created', task });
        }
      }
      logger.info(`resume-workflow: ${tasks.length} tasks loaded across ${workflows.length} workflows, ${allStarted.length} started`, { module: 'ipc' });
      if (allStarted.length > 0) {
        void requireTaskExecutor().executeTasks(allStarted);
      }
      requireTaskExecutor().resumeMergeGatePolling();
      return { workflow: workflows[0], taskCount: tasks.length, startedCount: allStarted.length };
    });

    registerGuiMutationHandler('invoker:stop', async () => {
      logger.info('stop — destroying all executors', { module: 'ipc' });
      const failInFlightTasks = (): void => {
        const allTasks = orchestrator.getAllTasks();
        for (const task of allTasks) {
          if (isTaskInFlightForForcedStop(task)) {
            logger.info(`stop — failing in-flight task "${task.id}" (${task.status})`, { module: 'ipc' });
            orchestrator.handleWorkerResponse({
              requestId: `stop-${task.id}`,
              actionId: task.id,
              attemptId: task.execution.selectedAttemptId,
              executionGeneration: task.execution.generation ?? 0,
              status: 'failed',
              outputs: { exitCode: 1, error: 'Stopped by user' },
            });
          }
        }
      };
      failInFlightTasks();
      await Promise.all(executorRegistry.getAll().map(f => f.destroyAll()));
      failInFlightTasks();
    });

    registerGuiMutationHandler('invoker:clear', async () => {
      logger.info('clear — stopping all tasks and resetting DAG', { module: 'ipc' });
      const workflows = persistence.listWorkflows();

      for (const workflow of workflows) {
        try {
          await performCancelWorkflow(workflow.id);
        } catch (err) {
          logger.error(`clear: failed to cancel workflow "${workflow.id}": ${err}`, { module: 'ipc' });
        }
      }
      await Promise.all(executorRegistry.getAll().map(f => f.destroyAll().catch(() => undefined)));

      orchestrator = new Orchestrator({
        persistence,
        messageBus,
        taskRepository: new SqliteTaskRepository(persistence),
        maxConcurrency: effectiveMaxConcurrency,
        executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
        defaultPoolId: invokerConfig.defaultPoolId,
        availablePoolIds: Object.keys(invokerConfig.executionPools ?? {}),
        deferRunningUntilLaunch: true,
      });
      commandService = new CommandService(orchestrator);
      rebuildTaskRunner();
      taskHandles.clear();
    });

    ipcMain.handle('invoker:list-workflows', () => persistence.listWorkflows());
    ipcMain.handle('invoker:get-execution-pools', () => Object.keys(loadConfig().executionPools ?? {}));

    registerGuiMutationHandler('invoker:delete-all-workflows', async () => {
      logger.info('delete-all-workflows', { module: 'ipc' });
      assertDeleteAllEnabled();
      await sharedDeleteAllWorkflows({ logger, orchestrator, taskExecutor: taskExecutor ?? undefined });
      taskHandles.clear();
      lastKnownTaskStates.clear();
      lastKnownWorkflowCount = 0;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('invoker:workflows-changed', []);
      }
    });

    registerGuiMutationHandler('invoker:delete-all-workflows-bulk', async () => {
      logger.info('delete-all-workflows-bulk', { module: 'ipc' });
      assertDeleteAllEnabled();
      await sharedDeleteAllWorkflowsBulk({ logger, orchestrator, taskExecutor: taskExecutor ?? undefined });
      taskHandles.clear();
      lastKnownTaskStates.clear();
      lastKnownWorkflowCount = 0;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('invoker:workflows-changed', []);
      }
    });

    registerWorkflowScopedGuiMutationHandler(
      'invoker:delete-workflow',
      (workflowIdArg: unknown) => String(workflowIdArg),
      'high',
      async (workflowIdArg: unknown) => {
        const workflowId = String(workflowIdArg);
        logger.info(`delete-workflow: "${workflowId}"`, { module: 'ipc' });
        try {
          await performDeleteWorkflow(workflowId);

          // Update workflow count and send workflows-changed
          const workflows = persistence.listWorkflows();
          lastKnownWorkflowCount = workflows.length;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('invoker:workflows-changed', workflows);
          }
        } catch (err) {
          logger.error(`delete-workflow failed: ${err}`, { module: 'ipc' });
          throw err;
        }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:detach-workflow',
      (workflowIdArg: unknown) => String(workflowIdArg),
      'high',
      async (workflowIdArg: unknown, upstreamWorkflowIdArg: unknown) => {
        const workflowId = String(workflowIdArg);
        const upstreamWorkflowId = String(upstreamWorkflowIdArg);
        logger.info(
          `detach-workflow: workflow="${workflowId}" upstream="${upstreamWorkflowId}"`,
          { module: 'ipc' },
        );
        try {
          const envelope = makeEnvelope('detach-workflow', 'ui', 'workflow', {
            workflowId,
            upstreamWorkflowId,
          });
          const result = await commandService.detachWorkflow(envelope);
          if (!result.ok) throw new Error(result.error.message);
        } catch (err) {
          logger.error(`detach-workflow failed: ${err}`, { module: 'ipc' });
          throw err;
        }
      },
    );

    ipcMain.handle('invoker:load-workflow', (_event, workflowId: string) => {
      logger.info(`load-workflow: "${workflowId}"`, { module: 'ipc' });
      // Sync orchestrator so mutations (restart, approve, etc.) work on this workflow
      orchestrator.syncFromDb(workflowId);
      const tasks = persistence.loadTasks(workflowId);
      const workflow = persistence.loadWorkflow(workflowId);
      logger.info(`load-workflow: found ${tasks.length} tasks for "${workflow?.name ?? workflowId}"`, { module: 'ipc' });
      for (const task of tasks) {
        lastKnownTaskStates.set(task.id, JSON.stringify(task));
        if (mainWindow && !mainWindow.isDestroyed()) {
          sendTaskDeltaToRenderer({ type: 'created', task });
        }
      }
      return { workflow, tasks };
    });

    ipcMain.handle('invoker:get-tasks', (_event, forceRefresh?: boolean) => {
      const startedAtMs = Date.now();
      if (forceRefresh) {
        timeStartupPhase('get-tasks.force-refresh.syncAllFromDb', () => orchestrator.syncAllFromDb(), () => ({
          taskCount: orchestrator.getAllTasks().length,
        }));
      }
      const tasks = orchestrator.getAllTasks();
      const workflows = persistence.listWorkflows();
      if (forceRefresh) {
        const previousTaskIds = new Set(lastKnownTaskStates.keys());
        lastKnownTaskStates.clear();
        for (const task of tasks) {
          lastKnownTaskStates.set(task.id, JSON.stringify(task));
          previousTaskIds.delete(task.id);
          if (mainWindow && !mainWindow.isDestroyed()) {
            sendTaskDeltaToRenderer({ type: 'created', task });
          }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          for (const removedTaskId of previousTaskIds) {
            sendTaskDeltaToRenderer({ type: 'removed', taskId: removedTaskId, previousTaskStateVersion: 0 });
          }
          mainWindow.webContents.send('invoker:workflows-changed', workflows);
        }
        lastKnownWorkflowCount = workflows.length;
      }
      logger.info(
        `get-tasks(forceRefresh=${forceRefresh ? 'true' : 'false'}) returning ${tasks.length} tasks, ${workflows.length} workflows`,
        { module: 'ipc' },
      );
      if (forceRefresh) {
        recordStartupDuration('get-tasks.force-refresh.return', startedAtMs, {
          taskCount: tasks.length,
          workflowCount: workflows.length,
          jsonSizeBytes: Buffer.byteLength(JSON.stringify({ tasks, workflows }), 'utf8'),
        });
      }
      return { tasks, workflows };
    });
    ipcMain.handle('invoker:get-events', (_event, taskId: string) => persistence.getEvents(taskId));
    ipcMain.handle('invoker:get-status', () => orchestrator.getWorkflowStatus());
    ipcMain.handle('invoker:get-task-by-id', (_event, taskId: string) => loadTaskByIdFromPersistence(taskId) ?? null);
    ipcMain.handle('invoker:get-task-output', (_event, taskId: string) => persistence.getTaskOutput(taskId));

    ipcMain.handle('invoker:get-output-chunks', (_event, taskId: string) => persistence.getOutputChunks(taskId));

    ipcMain.handle('invoker:replay-output-from', (_event, taskId: string, fromOffset: number) =>
      persistence.replayOutputFrom(taskId, fromOffset)
    );

    ipcMain.handle('invoker:get-output-tail', (_event, taskId: string) => persistence.getOutputTail(taskId));

    ipcMain.handle('invoker:get-all-completed-tasks', () => {
      return persistence.loadAllCompletedTasks();
    });

    ipcMain.handle('invoker:get-claude-session', async (_event, sessionId: string) => {
      logger.info(`get-claude-session: "${sessionId}"`, { module: 'ipc' });
      try {
        const allTasks = orchestrator.getAllTasks();
        return await resolveAgentSession(sessionId, 'claude', agentRegistry, allTasks);
      } catch (err) {
        logger.error(`get-claude-session failed: ${err}`, { module: 'ipc' });
        return null;
      }
    });

    ipcMain.handle('invoker:get-agent-session', async (_event, sessionId: string, agentName?: string) => {
      logger.info(`get-agent-session: "${sessionId}" agent="${agentName ?? 'claude'}"`, { module: 'ipc' });
      try {
        const allTasks = orchestrator.getAllTasks();
        return await resolveAgentSession(sessionId, agentName ?? 'claude', agentRegistry, allTasks);
      } catch (err) {
        logger.error(`get-agent-session failed: ${err}`, { module: 'ipc' });
        return null;
      }
    });

    registerGuiMutationHandler('invoker:provide-input', async (taskIdArg: unknown, inputArg: unknown) => {
      const taskId = String(taskIdArg);
      const input = String(inputArg);
      const envelope = makeEnvelope('provide-input', 'ui', 'task', { taskId, input });
      const result = await commandService.provideInput(envelope);
      if (!result.ok) throw new Error(result.error.message);
    });

    registerWorkflowScopedGuiMutationHandler(
      'invoker:approve',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
      async (taskIdArg: unknown) => {
      const taskId = String(taskIdArg);
      logger.info(`approve: "${taskId}"`, { module: 'ipc' });
      const { started } = await performSharedApproveTask(taskId, 'ui');
      logger.info(`approve: commandService returned ${started.length} started tasks: [${started.map(t => `${t.id}(${t.status})`).join(', ')}]`, { module: 'ipc' });
      await finalizeMutationWithGlobalTopup({
        orchestrator,
        taskExecutor: requireTaskExecutor(),
        logger,
        context: 'ipc.approve',
        started,
        mutationTiming: activeMutationContext?.mutationTiming,
        scopedTaskIds: [taskId],
      });
      },
    );

    registerGuiMutationHandler('invoker:reject', async (taskIdArg: unknown, reasonArg?: unknown) => {
      const taskId = String(taskIdArg);
      const reason = reasonArg === undefined ? undefined : String(reasonArg);
      const envelope = makeEnvelope('reject', 'ui', 'task', { taskId, reason });
      const result = await commandService.reject(envelope);
      if (!result.ok) throw new Error(result.error.message);
    });

    registerGuiMutationHandler('invoker:select-experiment', async (taskIdArg: unknown, experimentIdArg: unknown) => {
      const taskId = String(taskIdArg);
      const experimentId = experimentIdArg as string | string[];
      const ids = Array.isArray(experimentId) ? experimentId : [experimentId];
      logger.info(`select-experiment: "${taskId}" experimentIds=${JSON.stringify(ids)}`, { module: 'ipc' });
      try {
        if (ids.length === 1) {
          // Single-select: serialized via CommandService
          const envelope = makeEnvelope('select-experiment', 'ui', 'task', { taskId, experimentId: ids[0] });
          const result = await commandService.selectExperiment(envelope);
          if (!result.ok) throw new Error(result.error.message);
          const runnable = result.data.filter(isDispatchableLaunch);
          await requireTaskExecutor().executeTasks(runnable);
        } else {
          // Multi-select: needs taskExecutor for branch merge, stays in workflow-actions
          const newlyStarted = await sharedSelectExperiments(taskId, ids, { orchestrator, taskExecutor: requireTaskExecutor() });
          await requireTaskExecutor().executeTasks(newlyStarted);
        }
      } catch (err) {
        logger.error(`select-experiment failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    // `invoker:restart-task` IPC channel — the channel name is kept
    // for UI compatibility (renaming would require coordinated UI
    // changes, deferred to a follow-up). The handler now routes
    // through `commandService.retryTask` per Step 13's vocabulary
    // cleanup so the UI's "Restart" context-menu action keeps its
    // historical retry-class semantics (preserves
    // branch/workspacePath lineage). The channel itself carries an
    // `@deprecated` marker in `packages/contracts/src/ipc-channels.ts`.
    registerWorkflowScopedGuiMutationHandler(
      'invoker:restart-task',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'high',
      async (taskIdArg: unknown) => {
      const taskId = String(taskIdArg);
      logger.info(`restart-task → retry-task (Step 13 vocabulary): "${taskId}"`, { module: 'ipc' });
      try {
        await preemptTaskSubgraph(taskId);
        const envelope = makeEnvelope('retry-task', 'ui', 'task', { taskId });
        const result = await commandService.retryTask(envelope);
        if (!result.ok) throw new Error(result.error.message);
        const started = result.data;
        logger.info(
          `${RESTART_TO_BRANCH_TRACE} ipc invoker:restart-task after commandService.retryTask: count=${started.length} [${started.map((t) => `${t.id}(${t.status})`).join(', ')}]`,
          { module: 'ipc' },
        );
        const runnable = started.filter(isDispatchableLaunch);
        logger.info(
          `${RESTART_TO_BRANCH_TRACE} ipc invoker:restart-task runnable=${runnable.length} [${runnable.map((t) => t.id).join(', ') || '(none)'}] → taskExecutor.executeTasks`,
          { module: 'ipc' },
        );
        await dispatchStartedTasksWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.restart-task',
          started,
          scopedTaskIds: [taskId],
        });
      } catch (err) {
        logger.error(`restart-task failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:cancel-task',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'high',
      async (taskIdArg: unknown) => {
      const taskId = String(taskIdArg);
      logger.info(`cancel-task: "${taskId}"`, { module: 'ipc' });
      try {
        const result = await performCancelTask(taskId);
        await finalizeMutationWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.cancel-task',
          mutationTiming: activeMutationContext?.mutationTiming,
        });
        return result;
      } catch (err) {
        logger.error(`cancel-task failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:cancel-workflow',
      (workflowIdArg: unknown) => String(workflowIdArg),
      'high',
      async (workflowIdArg: unknown) => {
      const workflowId = String(workflowIdArg);
      logger.info(`cancel-workflow: "${workflowId}"`, { module: 'ipc' });
      try {
        const result = await preemptWorkflowBeforeMutation(workflowId, {
          preemptWorkflowExecution,
          logger,
          context: 'ipc.cancel-workflow',
          mutationTiming: activeMutationContext?.mutationTiming,
        });
        await finalizeMutationWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.cancel-workflow',
          mutationTiming: activeMutationContext?.mutationTiming,
        });
        return result;
      } catch (err) {
        logger.error(`cancel-workflow failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    ipcMain.handle('invoker:get-queue-status', () => {
      return orchestrator.getQueueStatus();
    });

    ipcMain.handle('invoker:get-action-graph', () => {
      orchestrator.syncAllFromDb();
      const tasks = orchestrator.getAllTasks();
      const workflows = persistence.listWorkflows();
      return buildActionGraphDiagnostics({
        workflows,
        tasks,
        attemptsByTaskId: new Map(tasks.map((task) => [task.id, persistence.loadAttempts(task.id)])),
        queueStatus: orchestrator.getQueueStatus(),
        mutationIntents: persistence.listWorkflowMutationIntents(),
        mutationLeases: persistence.listWorkflowMutationLeases(),
        eventsByTaskId: new Map(tasks.map((task) => [task.id, persistence.getEvents(task.id)])),
        activityLogs: persistence.getActivityLogs(0, 200),
        stallThresholdMs: resolveActionDiagnosticsStallThresholdMs(invokerConfig),
      });
    });

    ipcMain.handle('invoker:report-ui-perf', (_event, metric: string, data?: Record<string, unknown>) => {
      const payload = {
        ts: new Date().toISOString(),
        metric,
        ...(data ?? {}),
      };
      if (metric === 'renderer_event_loop_lag' && typeof data?.lagMs === 'number') {
        const hiddenOrUnfocused = data.visibilityState === 'hidden' || data.hasFocus === false;
        if (hiddenOrUnfocused) {
          uiPerfStats.maxRendererHiddenEventLoopLagMs = Math.max(uiPerfStats.maxRendererHiddenEventLoopLagMs, data.lagMs);
        } else {
          uiPerfStats.maxRendererEventLoopLagMs = Math.max(uiPerfStats.maxRendererEventLoopLagMs, data.lagMs);
        }
        if (typeof data.cumulativeLagMs === 'number') {
          uiPerfStats.maxRendererCumulativeLagMs = Math.max(uiPerfStats.maxRendererCumulativeLagMs, data.cumulativeLagMs);
        }
        if (typeof data.tickDeltaMs === 'number') {
          uiPerfStats.maxRendererTickDeltaMs = Math.max(uiPerfStats.maxRendererTickDeltaMs, data.tickDeltaMs);
        }
      }
      if (metric === 'renderer_long_task' && typeof data?.durationMs === 'number') {
        uiPerfStats.maxRendererLongTaskMs = Math.max(uiPerfStats.maxRendererLongTaskMs, data.durationMs);
      }
      uiPerfStats.rendererReports += 1;
      try {
        persistence.writeActivityLog('ui-perf', 'info', JSON.stringify(payload));
      } catch {
        // DB might be locked
      }
    });

    ipcMain.handle('invoker:get-ui-perf-stats', () => ({
      ...getUiPerfStats(),
    }));

    registerWorkflowScopedGuiMutationHandler(
      'invoker:recreate-workflow',
      (workflowIdArg: unknown) => String(workflowIdArg),
      'high',
      async (workflowIdArg: unknown) => {
      const workflowId = String(workflowIdArg);
      cancelDeferredWorkflowLaunch(workflowId, 'ipc.recreate-workflow');
      logger.info(`recreate-workflow: "${workflowId}"`, { module: 'ipc' });
      try {
        await preemptWorkflowBeforeMutation(workflowId, {
          preemptWorkflowExecution,
          logger,
          context: 'ipc.recreate-workflow',
          mutationTiming: activeMutationContext?.mutationTiming,
        });
        const started = activeMutationContext?.mutationTiming
          ? await activeMutationContext.mutationTiming.span(
            'main.ipc.recreate-workflow.sharedRecreateWorkflow',
            undefined,
            async () => sharedRecreateWorkflow(workflowId, { persistence, orchestrator }),
          )
          : sharedRecreateWorkflow(workflowId, { persistence, orchestrator });
        remoteFetchForPool.enabled = false;
        try {
          await dispatchStartedTasksWithGlobalTopup({
            orchestrator,
            taskExecutor: requireTaskExecutor(),
            logger,
            context: 'ipc.recreate-workflow',
            started,
            scopedWorkflowId: workflowId,
            mutationTiming: activeMutationContext?.mutationTiming,
          });
        } finally {
          remoteFetchForPool.enabled = true;
        }
      } catch (err) {
        logger.error(`recreate-workflow failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:recreate-task',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'high',
      async (taskIdArg: unknown) => {
      const taskId = String(taskIdArg);
      logger.info(`recreate-task: "${taskId}"`, { module: 'ipc' });
      try {
        if (activeMutationContext?.mutationTiming) {
          await activeMutationContext.mutationTiming.span(
            'main.ipc.recreate-task.preemptTaskSubgraph',
            { taskId },
            () => preemptTaskSubgraph(taskId),
          );
        } else {
          await preemptTaskSubgraph(taskId);
        }
        const started = activeMutationContext?.mutationTiming
          ? await activeMutationContext.mutationTiming.span(
            'main.ipc.recreate-task.sharedRecreateTask',
            { taskId },
            async () => sharedRecreateTask(taskId, { persistence, orchestrator }),
          )
          : sharedRecreateTask(taskId, { persistence, orchestrator });
        remoteFetchForPool.enabled = false;
        try {
          await dispatchStartedTasksWithGlobalTopup({
            orchestrator,
            taskExecutor: requireTaskExecutor(),
            logger,
            context: 'ipc.recreate-task',
            started,
            scopedTaskIds: [taskId],
            mutationTiming: activeMutationContext?.mutationTiming,
          });
        } finally {
          remoteFetchForPool.enabled = true;
        }
      } catch (err) {
        logger.error(`recreate-task failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:retry-workflow',
      (workflowIdArg: unknown) => String(workflowIdArg),
      'high',
      async (workflowIdArg: unknown) => {
      const workflowId = String(workflowIdArg);
      cancelDeferredWorkflowLaunch(workflowId, 'ipc.retry-workflow');
      logger.info(`retry-workflow: "${workflowId}"`, { module: 'ipc' });
      try {
        await preemptWorkflowBeforeMutation(workflowId, {
          preemptWorkflowExecution,
          logger,
          context: 'ipc.retry-workflow',
          mutationTiming: activeMutationContext?.mutationTiming,
        });
        const envelope = makeEnvelope('retry-workflow', 'ui', 'workflow', { workflowId });
        const result = activeMutationContext?.mutationTiming
          ? await activeMutationContext.mutationTiming.span(
            'main.ipc.retry-workflow.commandService.retryWorkflow',
            undefined,
            () => commandService.retryWorkflow(envelope),
          )
          : await commandService.retryWorkflow(envelope);
        if (!result.ok) throw new Error(result.error.message);
        remoteFetchForPool.enabled = false;
        try {
          await dispatchStartedTasksWithGlobalTopup({
            orchestrator,
            taskExecutor: requireTaskExecutor(),
            logger,
            context: 'ipc.retry-workflow',
            started: result.data,
            scopedWorkflowId: workflowId,
            mutationTiming: activeMutationContext?.mutationTiming,
          });
        } finally {
          remoteFetchForPool.enabled = true;
        }
      } catch (err) {
        logger.error(`retry-workflow failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:rebase-and-retry',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'high',
      async (taskIdArg: unknown) => {
      const taskId = String(taskIdArg);
      logger.info(`rebase-and-retry: "${taskId}"`, { module: 'ipc' });
      try {
        const workflowId = workflowIdForTaskArg(taskIdArg);
        if (workflowId) {
          await preemptWorkflowBeforeMutation(workflowId, {
            preemptWorkflowExecution,
            logger,
            context: 'ipc.rebase-and-retry',
            mutationTiming: activeMutationContext?.mutationTiming,
          });
        }
        const started = await rebaseAndRetry(taskId, {
          orchestrator,
          persistence,
          repoRoot,
          taskExecutor: requireTaskExecutor(),
          mutationTiming: activeMutationContext?.mutationTiming,
        });
        await dispatchStartedTasksWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.rebase-and-retry',
          started,
          ...(workflowId ? { scopedWorkflowId: workflowId } : { scopedTaskIds: [taskId] }),
          mutationTiming: activeMutationContext?.mutationTiming,
        });
      } catch (err) {
        logger.error(`rebase-and-retry failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:recreate-with-rebase',
      (workflowIdArg: unknown) => workflowIdForTargetArg(workflowIdArg),
      'high',
      async (workflowIdArg: unknown) => {
      const workflowId = workflowIdForTargetArg(workflowIdArg);
      if (!workflowId) {
        throw new Error(`Could not resolve workflow for recreate-with-rebase target "${String(workflowIdArg)}"`);
      }
      cancelDeferredWorkflowLaunch(workflowId, 'ipc.recreate-with-rebase');
      logger.info(`recreate-with-rebase: "${workflowId}"`, { module: 'ipc' });
      try {
        await preemptWorkflowBeforeMutation(workflowId, {
          preemptWorkflowExecution,
          logger,
          context: 'ipc.recreate-with-rebase',
          mutationTiming: activeMutationContext?.mutationTiming,
        });
        const started = await recreateWithRebase(workflowId, {
          orchestrator,
          persistence,
          repoRoot,
          taskExecutor: requireTaskExecutor(),
          mutationTiming: activeMutationContext?.mutationTiming,
        });
        await dispatchStartedTasksWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.recreate-with-rebase',
          started,
          scopedWorkflowId: workflowId,
          mutationTiming: activeMutationContext?.mutationTiming,
        });
      } catch (err) {
        logger.error(`recreate-with-rebase failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerGuiMutationHandler('invoker:set-merge-branch', async (workflowIdArg: unknown, baseBranchArg: unknown) => {
      const workflowId = String(workflowIdArg);
      const baseBranch = String(baseBranchArg);
      logger.info(`set-merge-branch: workflow="${workflowId}" → "${baseBranch}"`, { module: 'ipc' });
      try {
        persistence.updateWorkflow(workflowId, { baseBranch });

        const tasks = persistence.loadTasks(workflowId);
        const mergeTask = tasks.find(t => t.config.isMergeNode);
        if (mergeTask) {
          const started = orchestrator.retryTask(mergeTask.id);
          await dispatchStartedTasksWithGlobalTopup({
            orchestrator,
            taskExecutor: requireTaskExecutor(),
            logger,
            context: 'ipc.set-merge-branch',
            started,
            scopedTaskIds: [mergeTask.id],
          });
        }
      } catch (err) {
        logger.error(`set-merge-branch failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    registerGuiMutationHandler('invoker:set-merge-mode', async (workflowIdArg: unknown, mergeModeArg: unknown) => {
      const workflowId = String(workflowIdArg);
      const mergeMode = String(mergeModeArg);
      logger.info(`set-merge-mode: workflow="${workflowId}" → "${mergeMode}"`, { module: 'ipc' });
      try {
        await setWorkflowMergeMode(workflowId, mergeMode, {
          orchestrator,
          persistence,
          taskExecutor: requireTaskExecutor(),
        });
      } catch (err) {
        logger.error(`set-merge-mode failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      const workflows = persistence.listWorkflows();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('invoker:workflows-changed', workflows);
      }
    });

    registerWorkflowScopedGuiMutationHandler(
      'invoker:approve-merge',
      (workflowIdArg: unknown) => String(workflowIdArg),
      'normal',
      async (workflowIdArg: unknown) => {
      const workflowId = String(workflowIdArg);
      logger.info(`approve-merge: "${workflowId}"`, { module: 'ipc' });
      try {
        const mergeTask = orchestrator.getMergeNode(workflowId);
        if (!mergeTask) throw new Error(`No merge node for workflow ${workflowId}`);
        const { started } = await performSharedApproveTask(mergeTask.id, 'ui', 'workflow');
        await finalizeMutationWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.approve-merge',
          started,
          mutationTiming: activeMutationContext?.mutationTiming,
          scopedWorkflowId: workflowId,
        });
      } catch (err) {
        logger.error(`approve-merge failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerGuiMutationHandler('invoker:check-pr-statuses', async () => {
      logger.info('check-pr-statuses', { module: 'ipc' });
      await requireTaskExecutor().checkMergeGateStatuses();
    });

    registerGuiMutationHandler('invoker:check-pr-status', async () => {
      const tasks = orchestrator.getAllTasks();
      const awaitingMergeGates = tasks.filter(
        t => t.config.isMergeNode && (t.status === 'review_ready' || t.status === 'awaiting_approval')
      );
      await Promise.all(
        awaitingMergeGates.map(t => requireTaskExecutor().checkPrApprovalNow(t.id))
      );
    });

    registerWorkflowScopedGuiMutationHandler(
      'invoker:resolve-conflict',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
      async (taskIdArg: unknown, agentNameArg?: unknown) => {
      const taskId = String(taskIdArg);
      const agentName = agentNameArg === undefined ? undefined : String(agentNameArg);
      logger.info(
        `resolve-conflict: "${taskId}" agent=${agentName ?? 'claude'} source=ipc route=resolveConflictAction`,
        { module: 'ipc' },
      );
      try {
        const result = await resolveConflictAction(taskId, {
          orchestrator,
          persistence,
          taskExecutor: requireTaskExecutor(),
          autoApproveAIFixes: invokerConfig.autoApproveAIFixes,
        }, agentName, activeMutationContext?.signal);
        await finalizeMutationWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.resolve-conflict',
          started: result.started,
          mutationTiming: activeMutationContext?.mutationTiming,
          scopedTaskIds: [taskId],
        });
      } catch (err) {
        await finalizeMutationWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.resolve-conflict.failure',
          mutationTiming: activeMutationContext?.mutationTiming,
        });
        logger.error(`resolve-conflict failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:fix-with-agent',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
      async (taskIdArg: unknown, agentNameArg?: unknown) => {
      const taskId = String(taskIdArg);
      const agentName = agentNameArg === undefined ? undefined : String(agentNameArg);
      try {
        const started = await executeFixWithAgentMutation(taskId, agentName);
        await finalizeMutationWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.fix-with-agent',
          started,
          mutationTiming: activeMutationContext?.mutationTiming,
          scopedTaskIds: [taskId],
        });
      } catch (err) {
        await finalizeMutationWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.fix-with-agent.failure',
          mutationTiming: activeMutationContext?.mutationTiming,
        });
        logger.error(`fix-with-agent failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerGuiMutationHandler('invoker:edit-task-command', async (taskIdArg: unknown, newCommandArg: unknown) => {
      const taskId = String(taskIdArg);
      const newCommand = String(newCommandArg);
      logger.info(`edit-task-command: "${taskId}" → "${newCommand}"`, { module: 'ipc' });
      try {
        const envelope = makeEnvelope('edit-task-command', 'ui', 'task', { taskId, newCommand });
        const result = await commandService.editTaskCommand(envelope);
        if (!result.ok) throw new Error(result.error.message);
        await dispatchStartedTasksWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.edit-task-command',
          started: result.data,
          scopedTaskIds: [taskId],
        });
      } catch (err) {
        logger.error(`edit-task-command failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    registerGuiMutationHandler('invoker:edit-task-prompt', async (taskIdArg: unknown, newPromptArg: unknown) => {
      const taskId = String(taskIdArg);
      const newPrompt = String(newPromptArg);
      logger.info(`edit-task-prompt: "${taskId}" → "${newPrompt}"`, { module: 'ipc' });
      try {
        const envelope = makeEnvelope('edit-task-prompt', 'ui', 'task', { taskId, newPrompt });
        const result = await commandService.editTaskPrompt(envelope);
        if (!result.ok) throw new Error(result.error.message);
        await dispatchStartedTasksWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.edit-task-prompt',
          started: result.data,
          scopedTaskIds: [taskId],
        });
      } catch (err) {
        logger.error(`edit-task-prompt failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    registerGuiMutationHandler('invoker:edit-task-type', async (taskIdArg: unknown, runnerKindArg: unknown, poolMemberIdArg?: unknown) => {
      const taskId = String(taskIdArg);
      const runnerKind = String(runnerKindArg);
      const poolMemberId = poolMemberIdArg === undefined ? undefined : String(poolMemberIdArg);
      logger.info(`edit-task-type: "${taskId}" → "${runnerKind}" poolMemberId=${poolMemberId ?? 'none'}`, { module: 'ipc' });
      try {
        const envelope = makeEnvelope('edit-task-type', 'ui', 'task', { taskId, runnerKind, poolMemberId });
        const result = await commandService.editTaskType(envelope);
        if (!result.ok) throw new Error(result.error.message);
        await dispatchStartedTasksWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.edit-task-type',
          started: result.data,
          scopedTaskIds: [taskId],
        });
      } catch (err) {
        logger.error(`edit-task-type failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    registerGuiMutationHandler('invoker:edit-task-pool', async (taskIdArg: unknown, poolIdArg: unknown) => {
      const taskId = String(taskIdArg);
      const poolId = String(poolIdArg);
      logger.info(`edit-task-pool: "${taskId}" → "${poolId}"`, { module: 'ipc' });
      try {
        const envelope = makeEnvelope('edit-task-pool', 'ui', 'task', { taskId, poolId });
        const result = await commandService.editTaskPool(envelope);
        if (!result.ok) throw new Error(result.error.message);
        await dispatchStartedTasksWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.edit-task-pool',
          started: result.data,
          scopedTaskIds: [taskId],
        });
      } catch (err) {
        logger.error(`edit-task-pool failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    registerGuiMutationHandler('invoker:edit-task-agent', async (taskIdArg: unknown, agentNameArg: unknown) => {
      const taskId = String(taskIdArg);
      const agentName = String(agentNameArg);
      logger.info(`edit-task-agent: "${taskId}" → "${agentName}"`, { module: 'ipc' });
      try {
        const envelope = makeEnvelope('edit-task-agent', 'ui', 'task', { taskId, agentName });
        const result = await commandService.editTaskAgent(envelope);
        if (!result.ok) throw new Error(result.error.message);
        await dispatchStartedTasksWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.edit-task-agent',
          started: result.data,
          scopedTaskIds: [taskId],
        });
      } catch (err) {
        logger.error(`edit-task-agent failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    registerGuiMutationHandler(
      'invoker:set-task-external-gate-policies',
      async (taskIdArg: unknown, updatesArg: unknown) => {
        const taskId = String(taskIdArg);
        const updates = updatesArg as Array<{ workflowId: string; taskId?: string; gatePolicy: 'completed' | 'review_ready' }>;
        logger.info(`set-task-external-gate-policies: "${taskId}" updates=${updates.length}`, { module: 'ipc' });
        try {
          const envelope = makeEnvelope('set-gate-policies', 'ui', 'task', { taskId, updates });
          const result = await commandService.setTaskExternalGatePolicies(envelope);
          if (!result.ok) throw new Error(result.error.message);
          await dispatchStartedTasksWithGlobalTopup({
            orchestrator,
            taskExecutor: requireTaskExecutor(),
            logger,
            context: 'ipc.set-task-external-gate-policies',
            started: result.data,
            scopedTaskIds: [taskId],
          });
        } catch (err) {
          logger.error(`set-task-external-gate-policies failed: ${err}`, { module: 'ipc' });
          throw err;
        }
      },
    );

    ipcMain.handle('invoker:get-remote-targets', () => {
      return Object.keys(loadConfig().remoteTargets ?? {});
    });

    ipcMain.handle('invoker:get-execution-agents', () => {
      return agentRegistry.listExecution().map(a => a.name);
    });

    ipcMain.handle('invoker:get-system-diagnostics', () => {
      return collectSystemDiagnostics({
        appVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        bundledSkills: getBundledSkillsStatus(),
      });
    });

    ipcMain.handle('invoker:get-bundled-skills-status', () => {
      return getBundledSkillsStatus();
    });

    ipcMain.handle('invoker:install-bundled-skills', (_event, mode = 'install') => {
      return installPackagedSkills(mode);
    });

    registerGuiMutationHandler('invoker:replace-task', async (taskIdArg: unknown, replacementTasksArg: unknown) => {
      const taskId = String(taskIdArg);
      const replacementTasks = replacementTasksArg as unknown[];
      logger.info(`replace-task: "${taskId}" with ${replacementTasks.length} replacement(s)`, { module: 'ipc' });
      try {
        const envelope = makeEnvelope('replace-task', 'ui', 'task', {
          taskId,
          replacementTasks: replacementTasks as TaskReplacementDef[],
        });
        const result = await commandService.replaceTask(envelope);
        if (!result.ok) throw new Error(result.error.message);
        await dispatchStartedTasksWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.replace-task',
          started: result.data,
          scopedTaskIds: [taskId, ...result.data.map((task) => task.id)],
        });
        return result.data;
      } catch (err) {
        logger.error(`replace-task failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    });

    // ── DB Polling — detect external workflow changes ───
    ipcMain.handle('invoker:get-activity-logs', () => {
      return persistence.getActivityLogs(0, 2000);
    });

    // ── External terminal launcher ──────────────────────────────
    ipcMain.handle('invoker:open-terminal', async (_event, taskId: string): Promise<{ opened: boolean; reason?: string }> => {
      logger.info(`invoked for task="${taskId}"`, { module: 'open-terminal' });
      return openExternalTerminalForTask({
        taskId,
        persistence,
        executorRegistry,
        executionAgentRegistry: agentRegistry,
        repoRoot,
        logger,
        runningTaskReason:
          'Task is still running or being fixed with AI. View output in the terminal panel below.',
      });
    });

    seedUiSnapshotCache();
    createWindow();
    recordStartupMark('createWindow.end');

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  }).catch((err) => {
    process.stderr.write(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
    app.quit();
  });

  app.on('window-all-closed', () => {
    logger.info('window-all-closed', { module: 'window' });
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  let isQuitting = false;
  app.on('before-quit', async (event) => {
    if (isQuitting) return;
    isQuitting = true;
    logger.info('before-quit begin', { module: 'process' });
    event.preventDefault();

    const safetyTimer = setTimeout(() => {
      console.error('[quit] Cleanup timed out after 10s, forcing exit');
      process.exit(1);
    }, 10_000);

    try {
      if (apiServer) await apiServer.close().catch(() => {});
      if (dbPollInterval) clearInterval(dbPollInterval);
      if (activityPollInterval) clearInterval(activityPollInterval);
      if (uiPerfLogInterval) clearInterval(uiPerfLogInterval);
      if (hourlyBackupInterval) {
        clearInterval(hourlyBackupInterval);
        hourlyBackupInterval = null;
      }
      if (executorRegistry) {
        await Promise.all(executorRegistry.getAll().map(f => f.destroyAll()));
      }
      if (orchestrator) {
        for (const task of orchestrator.getAllTasks()) {
          if (task.status === 'running' || task.status === 'fixing_with_ai') {
            if (persistence) {
              persistShutdownDiagnostic(task, persistence, {
                flushPendingOutput: flushTaskOutput,
              });
            }
            orchestrator.handleWorkerResponse({
              requestId: `quit-${task.id}`,
              actionId: task.id,
              executionGeneration: task.execution.generation ?? 0,
              status: 'failed',
              outputs: { exitCode: 1, error: 'Application quit' },
            });
          }
        }
      }
      if (persistence) persistence.close();
      if (writerLock) writerLock.release();
      if (messageBus) messageBus.disconnect();
    } finally {
      clearTimeout(safetyTimer);
      logger.info('before-quit end -> app.exit(0)', { module: 'process' });
      app.exit(0);
    }
  });

  // ── Slack Bot (embedded in GUI process) ──────────────────
  async function startSlackBot(
    executor: TaskRunner,
    handles: Map<string, { handle: ExecutorHandle; executor: Executor }>,
  ): Promise<void> {
    const logFn = (source: string, level: string, message: string) => {
      const logMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info';
      logger[logMethod](message, { module: source });
      try { persistence.writeActivityLog(source, level, message); } catch { /* db locked */ }
    };

    await wireSlackBot({
      executor,
      logFn,
      approveTaskAction: async (taskId: string) => {
        const workflowId = orchestrator.getTask(taskId)?.config.workflowId;
        await runWorkflowMutation(workflowId, 'normal', 'surface:approve-task', [taskId], async () => {
          await performSharedApproveTask(taskId, 'surface');
        });
      },
      onStartPlan: () => handles.clear(),
      onPlanLoaded: () => {},
    });

    logFn('slack', 'info', 'Slack bot started (embedded in GUI)');
  }
}
