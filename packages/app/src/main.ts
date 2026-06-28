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
 *   electron dist/main.js --headless rebase-retry <workflowId|mergeTaskId|taskId>
 *   electron dist/main.js --headless rebase-recreate <workflowId|mergeTaskId|taskId>
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

import { app, dialog, ipcMain, Menu, type BrowserWindow } from 'electron';
import * as path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { config as loadDotenv } from 'dotenv';
import {
  configureEarlyElectronApp,
  formatGuiOwnerBootstrapFallbackMessage,
  guiOwnerBootstrapTimeoutMs,
  registerGuiLifecycleHandlers,
  resolveGuiOwnerPreference,
  runElectronReadyBootstrap,
  shouldRefreshGuiOwnerRoute,
  startGuiModeBootstrap,
  startMainProcessBootstrap,
} from './bootstrap/app-bootstrap.js';

const enableTestCompositor = process.env.INVOKER_E2E_ENABLE_COMPOSITOR === '1' || Boolean(process.env.CAPTURE_MODE);
const hideE2eWindow = process.env.NODE_ENV === 'test' && process.env.INVOKER_E2E_HIDE_WINDOW !== '0';
const earlyHeadlessMode = process.argv.includes('--headless')
  || process.argv.includes('--install-skills')
  || process.argv.slice(2).includes('install-skills');

configureEarlyElectronApp({ app, enableTestCompositor, isHeadless: earlyHeadlessMode });

// Isolate userData (and with it the single-instance lock) for e2e runs so a
// test instance can launch alongside a normally running Invoker.
if (process.env.INVOKER_USER_DATA_DIR) {
  app.setPath('userData', process.env.INVOKER_USER_DATA_DIR);
}

import { Orchestrator, CommandService, OrchestratorError, OrchestratorErrorCode, buildWorkflowInvalidationDeps } from '@invoker/workflow-core';
import type {
  PlanDefinition,
  TaskDelta,
  TaskReplacementDef,
  TaskState,
  TaskStateChanges,
} from '@invoker/workflow-core';
import {
  makeEnvelope,
  CommandError,
  IpcChannels,
  resolveInvokerIpcSocketPath,
  resolveRepoRoot,
} from '@invoker/contracts';
import type { ActionGraphResponse, BundledSkillsInstallMode, Logger, WorkflowMeta, WorkflowMutationAcceptedResult, WorkResponse } from '@invoker/contracts';
import { SQLiteAdapter, ConversationRepository, SqliteTaskRepository, WorkflowChannelRepository } from '@invoker/data-store';
import { IpcBus, Channels } from '@invoker/transport';
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
  WorktreeExecutor,
  initializeShellEnvironment,
  RESTART_TO_BRANCH_TRACE,
  remoteFetchForPool,
  registerBuiltinAgents,
  RepoPool,
  DEFAULT_EXECUTION_AGENT,
  type AgentRegistry,
} from '@invoker/execution-engine';
import { FileAndDbLogger } from './logger.js';
import type { TaskOutputData } from './types.js';
import {
  loadConfig,
  resolveEmbeddedTerminalBackendConfig,
  type EmbeddedTerminalBackendConfig,
  type InvokerConfig,
} from './config.js';
import {
  DEFAULT_WORKTREE_MAX_CONCURRENCY,
  assertExecutionCapacityInvariant,
  resolveEffectiveMaxConcurrency,
  shouldFatalOnExecutionCapacityOvercommit,
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
import { runStartupPrerequisites } from './startup-prerequisites.js';
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
import { resolveRefreshTaskGraphSnapshot } from './refresh-task-graph.js';
import { presetToExecutionAgent, gatherWorkflowContext as gatherWorkflowContextImpl } from './slack-workflow-context.js';
import {
  startStandaloneLaunchDispatcher,
  type StandaloneLaunchDispatcherController,
} from './headless-standalone-launch-dispatcher.js';
import {
  approveTask as sharedApproveTask,
  deleteAllWorkflows as sharedDeleteAllWorkflows,
  deleteAllWorkflowsBulk as sharedDeleteAllWorkflowsBulk,
  fixWithAgentAction,
  rebaseRetry,
  rebaseRecreate,
  rejectTask as sharedRejectTask,
  resolveConflictAction,
  selectFailureRecoveryRoute,
  selectExperiments as sharedSelectExperiments,
  setWorkflowMergeMode,
  StaleLineageError,
} from './workflow-actions.js';
import { execSync } from 'node:child_process';
import { resolveTaskTerminalSpec } from './open-terminal-for-task.js';
import {
  createBashTerminalBackend,
  createPtyTerminalBackend,
  EmbeddedTerminalManager,
  type EmbeddedTerminalBackend,
} from './embedded-terminal-manager.js';
import { collectSystemDiagnostics } from './system-diagnostics.js';
import { installBundledSkills, resolveBundledSkillsStatus } from './bundled-skills.js';
import {
  maybeAutoInstallCli,
  resolveCliInstallerStatus,
  updateInvokerCli,
  type CliInstallerContext,
} from './cli-installer.js';
import { resolveBundledCliPath } from './cli-helper.js';
import { buildAppMenuTemplate } from './app-menu.js';
import { createRequire } from 'node:module';
import { acquireDbWriterLock, type DbWriterLockResult } from './db-writer-lock.js';
import { applyDelta, recoverQuarantinedTask, TaskSnapshotCache } from './delta-merge.js';
import { CoalescedWorkflowMetadataPublisher } from './workflow-metadata-invalidation.js';
import { WorkflowRollupProjection } from './workflow-rollup-projection.js';
import { shouldSkipAutoFixForError } from './auto-fix-gating.js';
import type { WorkflowMutationPriority } from './workflow-mutation-coordinator.js';
import { PersistedWorkflowMutationCoordinator } from './persisted-workflow-mutation-coordinator.js';
import type { WorkflowMutationContext } from './persisted-workflow-mutation-coordinator.js';
import { LaunchDispatcher } from './launch-dispatcher.js';
import { recoverWorkflowMutationsOnStartup } from './workflow-mutation-startup.js';
import {
  dispatchStartedTasksWithGlobalTopup,
  executeGlobalTopup,
  finalizeMutationWithGlobalTopup,
  isDispatchableLaunch,
} from './global-topup.js';
import { preemptWorkflowBeforeMutation, type WorkflowCancelResult } from './workflow-preemption.js';
import { evaluateExecutingStall } from './executing-stall.js';
import {
  buildFixWithAgentMutationArgs,
  buildHeadlessFixArgs,
  listOpenFixIntentsForTask,
  parseFixWithAgentMutationArgs,
} from './auto-fix-intents.js';
import { persistShutdownDiagnostic } from './shutdown-diagnostic.js';
import { buildCurrentActionGraphSnapshot } from './action-graph-snapshot.js';
import { buildReviewGateQueryResponse } from './review-gate-query.js';
import { registerReadOnlyIpcHandlers } from './ipc-read-handlers.js';
import { createTaskGraphEventPublisher } from './task-graph-event-publisher.js';
import { buildWebInvokerDispatch } from './web/web-invoker-dispatch.js';
import { startWebBridge, resolveWebUiDistDir, type WebBridge } from './web/web-bridge-server.js';
import { resolveWebToken, resolveWebHost, resolveWebPort } from './web/start-web-surface.js';
import {
  createGuiMutationRegistrars,
  registerBootstrapStateIpc,
  type GuiMutationPayload,
  type GuiMutationRegistrationContext,
  type WorkflowScopedGuiMutationRegistrationContext,
} from './ipc/ipc-registration.js';
import { createTaskDeltaStreamSequence } from './task-delta-stream-sequence.js';
import { startLifecycleEventBridge, type LifecycleEventBridge } from './lifecycle-event-bridge.js';
import { startReviewGateStatusWorker, type ReviewGateStatusWorker } from './review-gate-status-worker.js';
import {
  buildRecoveryWorkerAuditPayload,
  classifyAutoFixRecoveryPhase,
  recoveryWorkerEventType,
} from './recovery-worker-observability.js';
import {
  executeNoTrackHeadlessBatch,
  type HeadlessBatchExecRequest,
  type HeadlessExecMutationPayload,
} from './headless-batch-exec.js';
import {
  spawnDetachedStandaloneOwner,
  tryAcquireOwnerBootstrapLock,
} from './headless-owner-bootstrap.js';
import { discoverOwner, isStandaloneCapable } from './owner-endpoint.js';
import {
  killRunningTaskExecution,
  rebuildTaskRunner as rebuildTaskRunnerWiring,
  requireWiredTaskRunner,
  type TaskHandleMap,
} from './execution/task-runner-wiring.js';
import {
  createMainWindow,
  registerMainWindowActivateHandler,
  registerMainWindowSecondInstanceHandler,
} from './window/window-lifecycle.js';
import { tryAcquireGuiInstanceLock, type GuiInstanceLock } from './gui-instance-lock.js';
import { logProcessError } from './process-error-handling.js';


function isTaskInFlightForForcedStop(task: TaskState): boolean {
  return task.status === 'running'
    || task.status === 'fixing_with_ai'
    || (task.status === 'pending' && task.execution.phase === 'launching');
}

function isTaskRecoverableOnExplicitResume(task: TaskState): boolean {
  if (task.status === 'running') return true;
  if (task.status !== 'pending' || !task.execution.selectedAttemptId) return false;
  if (task.execution.phase === 'launching') return true;

  return Boolean(
    task.execution.startedAt
    || task.execution.launchStartedAt
    || task.execution.launchCompletedAt
    || task.execution.lastHeartbeatAt
    || task.execution.workspacePath
    || task.execution.agentSessionId
    || task.execution.containerId
    || task.execution.error
    || task.execution.exitCode !== undefined
    || task.execution.inputPrompt
    || task.execution.pendingFixError,
  );
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

// ── Shared state ─────────────────────────────────────────────

let messageBus: MessageBus;
let persistence: SQLiteAdapter;
let executorRegistry: ExecutorRegistry;
let orchestrator: Orchestrator;
let commandService: CommandService;
// Latest TaskRunner reference for invalidation deps. CommandService is
// constructed in initServices before TaskRunner exists, so the deps
// resolve via this getter at cancel-in-flight time.
let latestTaskExecutor: TaskRunner | null = null;
let guiUsingDaemonOwner = false;

function buildCommandServiceInvalidationDeps() {
  return buildWorkflowInvalidationDeps({
    orchestrator,
    requireWorkflow: (workflowId) => {
      const workflow = persistence.loadWorkflow(workflowId);
      if (!workflow) {
        throw new OrchestratorError(
          OrchestratorErrorCode.WORKFLOW_NOT_FOUND,
          `Workflow ${workflowId} not found`,
        );
      }
      return workflow;
    },
    setWorkflowGeneration: (workflowId, generation) => {
      persistence.updateWorkflow(workflowId, { generation });
    },
    killActiveExecution: async (taskId) => {
      await latestTaskExecutor?.killActiveExecution(taskId);
    },
    prepareFreshBase: async (workflowId, workflow) => {
      if (!latestTaskExecutor || !workflow.repoUrl) return undefined;
      return latestTaskExecutor.preparePoolForRebaseRetry(
        workflowId,
        workflow.repoUrl,
        workflow.baseBranch,
      );
    },
    fixApprove: async (taskId) => {
      const result = await sharedApproveTask(taskId, {
        orchestrator,
        taskExecutor: latestTaskExecutor ?? undefined,
      });
      return result.started;
    },
    fixReject: (taskId) => {
      sharedRejectTask(taskId, { orchestrator });
      return [];
    },
  });
}
let runtimeServices: RuntimeServices;
let workflowMutationCoordinator: PersistedWorkflowMutationCoordinator | null = null;
let launchDispatcher: LaunchDispatcher | null = null;
const workflowMutationDispatcher = new Map<string, (...args: unknown[]) => Promise<unknown>>();
/**
 * The mutation context for the currently executing workflow mutation.
 * Set by the coordinator dispatch callback before invoking the handler,
 * cleared afterward. Allows fix-with-agent and conflict-resolution
 * handlers to read the AbortSignal without changing every handler signature.
 */
let activeMutationContext: WorkflowMutationContext | undefined;
let hourlyBackupInterval: ReturnType<typeof setInterval> | null = null;
let writerLock: DbWriterLockResult | null = null;
const workflowMutationOwnerId = `owner-${process.pid}-${Date.now()}`;
const appProcessStartedAt = Date.now();

interface HeadlessRunMutationPayload {
  planPath: string;
  traceId?: string;
}

interface HeadlessResumeMutationPayload {
  workflowId: string;
  traceId?: string;
}

type HeadlessOwnerMode = 'standalone' | 'gui';
function headlessExecLogFields(
  payload: HeadlessExecMutationPayload,
  mode: HeadlessOwnerMode,
  extra: Record<string, string | number | undefined> = {},
): string {
  const fields: Record<string, string | number | undefined> = {
    trace: payload.traceId ?? '<none>',
    args: `"${payload.args.join(' ')}"`,
    noTrack: payload.noTrack ? 'true' : 'false',
    ...extra,
    coordinator: workflowMutationCoordinator ? 'true' : 'false',
    mode,
  };
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value ?? '<none>'}`)
    .join(' ');
}

function logHeadlessExecReceived(payload: HeadlessExecMutationPayload, mode: HeadlessOwnerMode): void {
  logger.info(
    `headless.exec received ${headlessExecLogFields(payload, mode, { ownerId: workflowMutationOwnerId })}`,
    { module: 'ipc-delegate' },
  );
}

function acknowledgeNoTrackHeadlessExec(
  payload: HeadlessExecMutationPayload,
  workflowId: string | undefined,
  priority: WorkflowMutationPriority,
  mode: HeadlessOwnerMode,
): WorkflowMutationAcceptedResult | undefined {
  logger.info(
    `headless.exec decision ${headlessExecLogFields(payload, mode, { workflow: `"${workflowId ?? '<none>'}"`, priority })}`,
    { module: 'ipc-delegate' },
  );

  if (!payload.noTrack) return undefined;

  if (workflowId && workflowMutationCoordinator) {
    const intentId = workflowMutationCoordinator.submit(workflowId, priority, 'headless.exec', [payload], {
      deferDrain: true,
    });
    logger.info(
      `headless.exec accepted ${headlessExecLogFields(payload, mode, { workflow: `"${workflowId}"`, intent: intentId, priority })}`,
      { module: 'ipc-delegate' },
    );
    return { ok: true, accepted: true, intentId, workflowId, channel: 'headless.exec' };
  }

  const reason = !workflowId ? 'workflow-not-resolved' : 'coordinator-unavailable';
  logger.error(
    `headless.exec rejected ${headlessExecLogFields(payload, mode, { reason, workflow: `"${workflowId ?? '<none>'}"` })}`,
    { module: 'ipc-delegate' },
  );
  throw new Error(`Fire-and-forget headless.exec could not be queued: ${reason}`);
}

// Root logger: created early in initServices() once persistence is available.
// Before initServices(), use the pre-init logger (file-only, no DB).
let logger: Logger = new FileAndDbLogger({ module: 'main' });
let guiInstanceLock: GuiInstanceLock | null = null;
const buildSha = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev';
const buildVersion = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev';
logger.info(`Invoker ${buildVersion} (${buildSha})`, { module: 'startup' });

process.on('uncaughtException', (err) => {
  logProcessError('uncaughtException', err, { logger, fallbackConsole: console });
});

process.on('unhandledRejection', (reason) => {
  logProcessError('unhandledRejection', reason, { logger, fallbackConsole: console });
});

const repoRoot = resolveRepoRoot(__dirname, { fallback: process.resourcesPath });

// Load secrets from ~/.invoker/.env (canonical) then the repo .env BEFORE any startup guard
// reads process.env. dotenv never overrides vars already set in the real environment.
function loadInvokerEnvFiles(): void {
  for (const envPath of [path.join(homedir(), '.invoker', '.env'), path.resolve(repoRoot, '.env')]) {
    if (existsSync(envPath)) loadDotenv({ path: envPath });
  }
}
loadInvokerEnvFiles();
const invokerConfig: InvokerConfig = (() => {
  try {
    return loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
})();

async function discoverStandaloneOwnerForGui(waitMs: number): Promise<boolean> {
  let ownerBus = new IpcBus(undefined, { allowServe: false });
  try {
    await ownerBus.ready();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const owner = await discoverOwner(ownerBus, 500);
      if (isStandaloneCapable(owner)) {
        logger.info(`daemon owner ready ownerId=${owner.ownerId}`, { module: 'init' });
        return true;
      }
      ownerBus.disconnect();
      ownerBus = new IpcBus(undefined, { allowServe: false });
      await ownerBus.ready();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  } finally {
    ownerBus.disconnect();
  }
}

async function ensureStandaloneOwnerForGui(): Promise<void> {
  if (await discoverStandaloneOwnerForGui(2_000)) return;

  const invokerHomeRoot = resolveInvokerHomeRoot();
  const timeoutMs = guiOwnerBootstrapTimeoutMs();
  const bootstrapLock = tryAcquireOwnerBootstrapLock(invokerHomeRoot);
  try {
    if (bootstrapLock) {
      logger.info('spawning daemon owner for GUI client mode', { module: 'init' });
      spawnDetachedStandaloneOwner(repoRoot);
    } else {
      logger.info('waiting for daemon owner bootstrap held by another process', { module: 'init' });
    }
    if (await discoverStandaloneOwnerForGui(timeoutMs)) return;
  } finally {
    bootstrapLock?.release();
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for daemon owner`);
}

let guiOwnerRouteRefreshPromise: Promise<void> | null = null;

async function refreshGuiMutationOwnerRoute(): Promise<void> {
  const ownerPreference = resolveGuiOwnerPreference();
  if (!shouldRefreshGuiOwnerRoute(ownerPreference, guiUsingDaemonOwner)) return;
  if (!guiOwnerRouteRefreshPromise) {
    guiOwnerRouteRefreshPromise = (async () => {
      if (ownerPreference === 'daemon') {
        await ensureStandaloneOwnerForGui();
      } else if (!await discoverStandaloneOwnerForGui(2_000)) {
        throw new Error('No mutation owner is available');
      }
      const previousMessageBus = typeof messageBus === 'undefined' ? null : messageBus;
      const refreshedMessageBus = new IpcBus(undefined, { allowServe: false });
      await refreshedMessageBus.ready();
      messageBus = refreshedMessageBus;
      previousMessageBus?.disconnect();
      logger.info('refreshed daemon owner IPC route for GUI mutation', { module: 'ipc-delegate' });
    })().finally(() => {
      guiOwnerRouteRefreshPromise = null;
    });
  }
  await guiOwnerRouteRefreshPromise;
}

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
  executionAgentRegistry?: AgentRegistry;
  startupSyncMode?: 'all' | 'none';
}

function buildBundledSkillsContext() {
  return {
    isPackaged: app.isPackaged,
    repoRoot,
    resourcesPath: process.resourcesPath,
  };
}

function getBundledSkillsStatus() {
  return resolveBundledSkillsStatus(buildBundledSkillsContext());
}

function installPackagedSkills(mode: BundledSkillsInstallMode = 'install') {
  return installBundledSkills(buildBundledSkillsContext(), mode);
}

function buildCliInstallerContext(): CliInstallerContext {
  return {
    isPackaged: app.isPackaged,
    bundledCliPath: resolveBundledCliPath({ isPackaged: app.isPackaged }),
    appVersion: app.getVersion(),
    platform: process.platform,
    env: process.env,
    homeDir: homedir(),
  };
}

function updateInvokerCliFromMenu(): void {
  const result = updateInvokerCli(buildCliInstallerContext());
  const detail = result.ok
    ? result.updated
      ? `invoker-cli ${app.getVersion()} installed to ${result.installedTo}.${result.status.warning ? `\n\n${result.status.warning}` : ''}`
      : `invoker-cli is already up to date (${app.getVersion()}) at ${result.installedTo}.`
    : `Update failed: ${result.error}`;
  void dialog.showMessageBox({
    type: result.ok ? 'info' : 'error',
    message: 'Update invoker-cli',
    detail,
  });
}

async function initServices(options?: InitServicesOptions): Promise<void> {
  const invokerHomeRoot = resolveInvokerHomeRoot();
  mkdirSync(invokerHomeRoot, { recursive: true });
  const readOnly = options?.readOnly === true;
  const previousMessageBus = typeof messageBus === 'undefined' ? null : messageBus;
  previousMessageBus?.disconnect();
  const serviceMessageBus = new IpcBus(undefined, { allowServe: !readOnly });
  await serviceMessageBus.ready();
  messageBus = serviceMessageBus;
  const dbPath = path.join(invokerHomeRoot, 'invoker.db');
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
  const executionAgentRegistry = options?.executionAgentRegistry ?? registerBuiltinAgents();
  const runtimeServiceDeps = {
    workspaceProbe: new WorkspaceProbeAdapter(persistence),
    containerProbe: new ContainerProbeAdapter(persistence),
    sessionProbe: new SessionProbeAdapter(persistence),
    terminalLauncher: new TerminalLauncherAdapter({
      resumeCommandResolver: (agentName, sessionId) => {
        const agent = executionAgentRegistry.getOrThrow(agentName);
        const resume = agent.buildResumeArgs(sessionId);
        return { command: resume.cmd, args: resume.args };
      },
    }),
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
      agentRegistry: executionAgentRegistry,
    }),
  );
  const taskRepository = new SqliteTaskRepository(persistence);
  orchestrator = new Orchestrator({
    persistence, messageBus,
    taskRepository,
    maxConcurrency: effectiveMaxConcurrency,
    defaultAutoFixRetries: invokerConfig.autoFixRetries,
    executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
    defaultPoolId: invokerConfig.defaultPoolId,
    availablePoolIds: Object.keys(invokerConfig.executionPools ?? {}),
    deferRunningUntilLaunch: true,
  });
  commandService = new CommandService(
    orchestrator,
    buildCommandServiceInvalidationDeps(),
  );

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

const DEFAULT_SLACK_HARNESS_PRESETS: Record<string, { tool: 'cursor' | 'omp' | 'codex'; model?: string }> = {
  'cursor+claude': { tool: 'cursor', model: 'claude' },
  'cursor+codex': { tool: 'cursor', model: 'codex' },
  'omp+claude': { tool: 'omp', model: 'claude' },
  'omp+codex': { tool: 'omp', model: 'codex' },
  omp: { tool: 'omp' },
  codex: { tool: 'codex' },
};

interface SlackBotDeps {
  executor: TaskRunner;
  logFn: (source: string, level: string, message: string) => void;
  approveTaskAction?: (taskId: string) => Promise<void>;
  onStartPlan?: () => void;
  onPlanLoaded?: (plan: PlanDefinition) => void;
}

async function wireSlackBot(deps: SlackBotDeps): Promise<any> {

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
      repoUrl = execSync('git remote get-url origin', { cwd: repoRoot, encoding: 'utf8', timeout: 5000 }).trim();
    } catch {
      deps.logFn('slack', 'warn', 'Could not detect repoUrl from git remote; plans will require repoUrl in YAML');
    }
  }

  // ── Slack-native workflow wiring ──────────────────────────
  const planningRegistry = registerBuiltinAgents();
  const planningCommandBuilder = (
    opts: { tool: string; model?: string; prompt: string },
  ): { command: string; args: string[] } =>
    planningRegistry.getPlanningOrThrow(opts.tool).buildPlanningCommand(opts.prompt, { model: opts.model });

  const planningRepoPool = new RepoPool({ cacheDir: path.join(resolveInvokerHomeRoot(), 'planning-clones') });
  const prepareRepoCheckout = async (url: string): Promise<string> =>
    planningRepoPool.ensureCloneThroughRepoQueue(url);

  const workflowChannelRepo = new WorkflowChannelRepository(persistence);

  const harnessPresets = invokerConfig.slackHarnessPresets ?? DEFAULT_SLACK_HARNESS_PRESETS;
  const defaultHarnessPreset = invokerConfig.defaultSlackHarnessPreset ?? 'cursor+claude';
  const registeredExecutionAgents = new Set(planningRegistry.listExecution().map((a) => a.name));
  const resolveFallbackExecutionAgent = (presetKey?: string): string =>
    presetToExecutionAgent(presetKey, harnessPresets, registeredExecutionAgents, DEFAULT_EXECUTION_AGENT);

  const gatherWorkflowContext = (workflowId: string) =>
    gatherWorkflowContextImpl(
      {
        persistence,
        conversationRepo,
        workflowChannelRepo,
        agentRegistry: planningRegistry,
        log: (level, message) => deps.logFn('slack', level, message),
      },
      workflowId,
    );

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
    lobbyChannelId: process.env.SLACK_LOBBY_CHANNEL_ID ?? process.env.SLACK_CHANNEL_ID,
    planningCommandBuilder,
    prepareRepoCheckout,
    harnessPresets,
    defaultHarnessPreset,
    repoAliases: invokerConfig.slackRepos,
    defaultRepoUrl: invokerConfig.defaultRepoUrl ?? repoUrl,
    workflowChannelRepo,
    gatherWorkflowContext,
  });

  // ── Slack live workflow-progress card ─────────────────────
  const PROGRESS_DEBOUNCE_MS = 2500;
  const TERMINAL_DERIVED_STATUSES = new Set(['completed', 'failed', 'closed']);
  const progressTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const workflowIdFromTaskId = (taskId: string): string | undefined => {
    if (taskId.startsWith('__merge__')) return taskId.slice('__merge__'.length);
    const slash = taskId.indexOf('/');
    return slash <= 0 ? undefined : taskId.slice(0, slash);
  };

  const emitWorkflowProgress = async (workflowId: string): Promise<void> => {
    // Only mapped workflows get a live card — avoids posting for headless/non-Slack runs.
    if (!workflowChannelRepo.getByWorkflowId(workflowId)) return;
    const tasks = persistence.loadTasks(workflowId);
    const workflow = persistence.loadWorkflow(workflowId);
    const counts = orchestrator.getWorkflowStatus(workflowId);
    const percentComplete = counts.total > 0 ? Math.round((counts.completed / counts.total) * 100) : 0;
    const gate = buildReviewGateQueryResponse({ workflowId, workflow, tasks });
    const prUrl = gate.artifacts.find((artifact) => artifact.url)?.url;
    const reviewState = gate.mergeTaskId
      ? (gate.ready ? 'review ready' : (gate.status ?? undefined))
      : undefined;
    await slack.handleEvent({
      type: 'workflow_progress',
      progress: {
        workflowId,
        name: (workflow as { name?: string } | undefined)?.name ?? workflowId,
        counts,
        percentComplete,
        tasks: tasks.map((task) => ({
          id: task.id,
          name: task.description,
          status: task.status,
          phase: task.execution.phase,
          reviewUrl: task.execution.reviewUrl,
        })),
        prUrl,
        reviewState,
      },
    });
  };

  const scheduleWorkflowProgress = (workflowId: string, flushNow: boolean): void => {
    const existing = progressTimers.get(workflowId);
    if (existing) clearTimeout(existing);
    if (flushNow) {
      progressTimers.delete(workflowId);
      void emitWorkflowProgress(workflowId).catch((err) =>
        deps.logFn('slack', 'warn', `workflow-progress emit failed: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }
    const timer = setTimeout(() => {
      progressTimers.delete(workflowId);
      void emitWorkflowProgress(workflowId).catch((err) =>
        deps.logFn('slack', 'warn', `workflow-progress emit failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, PROGRESS_DEBOUNCE_MS);
    timer.unref?.();
    progressTimers.set(workflowId, timer);
  };

  messageBus.subscribe(Channels.TASK_DELTA, (delta: unknown) => {
    const d = delta as TaskDelta;
    const taskId = d.type === 'created' ? d.task.id : d.taskId;
    const workflowId = workflowIdFromTaskId(taskId);
    if (!workflowId || !workflowChannelRepo.getByWorkflowId(workflowId)) return;
    const status = d.type === 'updated'
      ? (d.changes.status as string | undefined)
      : d.type === 'created' ? d.task.status : undefined;
    // Flush immediately when this delta drives the workflow to a terminal state.
    let flushNow = false;
    if (status && TERMINAL_DERIVED_STATUSES.has(status)) {
      const counts = orchestrator.getWorkflowStatus(workflowId);
      flushNow = counts.running === 0 && counts.pending === 0;
    }
    scheduleWorkflowProgress(workflowId, flushNow);
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
        break;
      }
      case 'provide_input':
        orchestrator.provideInput(command.taskId, command.input);
        break;
      case 'retry': {
        const taskId = command.taskId as string;
        const result = await commandService.retryTask(
          makeEnvelope('retry-task', 'surface', 'task', { taskId }),
        );
        if (!result.ok) throw new Error(result.error.message);
        await dispatchStartedTasksWithGlobalTopup({
          orchestrator,
          taskExecutor: deps.executor,
          logger,
          context: 'surface.retry-task',
          started: result.data,
          scopedTaskIds: [taskId],
        });
        break;
      }
      case 'get_status': {
        const workflowId = command.workflowId as string | undefined;
        if (workflowId && workflowChannelRepo.getByWorkflowId(workflowId)) {
          await emitWorkflowProgress(workflowId);
        } else {
          const status = orchestrator.getWorkflowStatus(workflowId);
          await slack.handleEvent({ type: 'workflow_status', status, workflowId });
        }
        break;
      }
      case 'start_plan': {
        const { parsePlan } = await import('./plan-parser.js');
        const planText = command.planText as string;
        const plan = parsePlan(planText);
        const harnessPreset = command.harnessPreset as string | undefined;
        const fallbackAgent = resolveFallbackExecutionAgent(harnessPreset);
        for (const task of plan.tasks) {
          if (!task.executionAgent) task.executionAgent = fallbackAgent;
        }
        deps.logFn('trace', 'info', `slackBot: loading plan "${plan.name}" (${plan.tasks.length} tasks, defaultAgent=${fallbackAgent})`);
        deps.onStartPlan?.();
        deps.onPlanLoaded?.(plan);
        backupPlan(plan, undefined, logger);
        const before = new Set(orchestrator.getWorkflowIds());
        orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
        const workflowId = orchestrator.getWorkflowIds().find((id) => !before.has(id));
        if (workflowId) {
          await slack.handleEvent({
            type: 'workflow_created',
            workflowId,
            requestedBy: command.requestedBy as string | undefined,
            lobbyChannel: command.lobbyChannel as string | undefined,
            lobbyThreadTs: command.lobbyThreadTs as string | undefined,
            harnessPreset,
            repoUrl: command.repoUrl as string | undefined,
          });
        }
        const started = orchestrator.startExecution();
        deps.logFn('trace', 'info', `slackBot: startExecution returned ${started.length} tasks: [${started.map((t: any) => t.id).join(', ')}]`);
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
const YELLOW = '\x1b[33m';

// ══════════════════════════════════════════════════════════════
// HEADLESS MODE
// ══════════════════════════════════════════════════════════════

function startHeadlessMode(): void {
  const runHeadlessMain = async (): Promise<void> => {
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
    let reviewGateStatusWorker: ReviewGateStatusWorker | null = null;
    let lifecycleEventBridge: LifecycleEventBridge | null = null;
    let standaloneLaunchDispatcherController: StandaloneLaunchDispatcherController | null = null;
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
        appRootDir: __dirname,
      };

      const createStandaloneTaskExecutor = (): TaskRunner => {
        const executor = createHeadlessExecutor(headlessDeps);
        wireHeadlessApproveHook(headlessDeps, executor);
        return executor;
      };

      const executeStandaloneHeadlessRun = async (payload: HeadlessRunMutationPayload): Promise<unknown> => {
        const { parsePlanFile } = await import('./plan-parser.js');
        const plan = await parsePlanFile(payload.planPath);
        backupPlan(plan, undefined, logger);
        const wfIdsBefore = new Set(orchestrator.getWorkflowIds());
        orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
        const workflowId = orchestrator.getWorkflowIds().find((id) => !wfIdsBefore.has(id));
        if (!workflowId) {
          throw new Error(`Failed to resolve workflow id for delegated plan: ${payload.planPath}`);
        }
        const started = orchestrator.startExecution();
        logger.info(`standalone started ${started.length} tasks for workflow "${workflowId}"`, { module: 'ipc-delegate' });
        const tasks = orchestrator.getAllTasks().filter((task) => task.config.workflowId === workflowId);
        return { workflowId, tasks };
      };


      const executeStandaloneHeadlessResume = async (payload: HeadlessResumeMutationPayload): Promise<unknown> => {
        const { workflowId } = payload;
        const started = orchestrator.resumeWorkflow(workflowId);
        void started;
        logger.info(`standalone resumed ${started.length} tasks for workflow "${workflowId}"`, { module: 'ipc-delegate' });
        const tasks = orchestrator.getAllTasks().filter((task) => task.config.workflowId === workflowId);
        return { workflowId, tasks };
      };

      const executeStandaloneGuiMutation = async (payload: GuiMutationPayload): Promise<unknown> => {
        switch (payload.channel) {
          case 'invoker:clear': {
            logger.info('clear — stopping all tasks and resetting daemon DAG', { module: 'ipc-delegate' });
            await sharedDeleteAllWorkflows({ logger, orchestrator, taskExecutor: undefined });
            await Promise.all(executorRegistry.getAll().map(f => f.destroyAll().catch(() => undefined)));
            orchestrator = new Orchestrator({
              persistence,
              messageBus,
              taskRepository: new SqliteTaskRepository(persistence),
              maxConcurrency: effectiveMaxConcurrency,
              defaultAutoFixRetries: invokerConfig.autoFixRetries,
              executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
              defaultPoolId: invokerConfig.defaultPoolId,
              availablePoolIds: Object.keys(invokerConfig.executionPools ?? {}),
              deferRunningUntilLaunch: true,
            });
            commandService = new CommandService(
              orchestrator,
              buildCommandServiceInvalidationDeps(),
            );
            return undefined;
          }
          case 'invoker:load-plan': {
            const planText = String(payload.args[0] ?? '');
            const { parsePlan } = await import('./plan-parser.js');
            const plan = parsePlan(planText);
            backupPlan(plan, undefined, logger);
            orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
            return undefined;
          }
          case 'invoker:start':
            return orchestrator.startExecution();
          case 'invoker:stop': {
            logger.info('stop — destroying all daemon executors', { module: 'ipc-delegate' });
            const failInFlightTasks = (): void => {
              const allTasks = orchestrator.getAllTasks();
              for (const task of allTasks) {
                if (isTaskInFlightForForcedStop(task)) {
                  logger.info(`stop — failing in-flight task "${task.id}" (${task.status})`, { module: 'ipc-delegate' });
                  persistShutdownDiagnostic(task, persistence, { forcedStopReason: 'Stopped by user' });
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
            return undefined;
          }
          case 'invoker:inject-task-states': {
            if (process.env.NODE_ENV !== 'test') {
              throw new Error('inject-task-states is only available in tests');
            }
            const updates = payload.args[0] as Array<{ taskId: string; changes: TaskStateChanges }>;
            for (const { taskId, changes } of updates) {
              persistence.updateTask(taskId, changes);
            }
            orchestrator.syncAllFromDb();
            return undefined;
          }
          case 'invoker:set-merge-branch': {
            const workflowId = String(payload.args[0]);
            const baseBranch = String(payload.args[1]);
            persistence.updateWorkflow(workflowId, { baseBranch });
            const tasks = persistence.loadTasks(workflowId);
            const mergeTask = tasks.find((task) => task.config.isMergeNode);
            if (!mergeTask) return undefined;
            const executor = createStandaloneTaskExecutor();
            const envelope = makeEnvelope('set-merge-branch', 'ui', 'task', { taskId: mergeTask.id });
            const result = await commandService.retryTask(envelope);
            if (!result.ok) throw new Error(result.error.message);
            const started = result.data;
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
              return undefined;
            }
            await sharedSelectExperiments(taskId, ids, { orchestrator, taskExecutor: executor });
            return undefined;
          }
          case 'invoker:set-task-external-gate-policies': {
            const taskId = String(payload.args[0]);
            const updates = payload.args[1] as Array<{ workflowId: string; taskId?: string; gatePolicy: 'completed' | 'review_ready' }>;
            const envelope = makeEnvelope('set-gate-policies', 'ui', 'task', { taskId, updates });
            const result = await commandService.setTaskExternalGatePolicies(envelope);
            if (!result.ok) throw new Error(result.error.message);
            return undefined;
          }
          default:
            throw new Error(`Unsupported internal mutation for standalone owner: ${payload.channel}`);
        }
      };

      // In standalone owner mode, serve delegated requests from peer headless processes.
      if (standaloneMode && messageBus) {
        const standaloneOwnerIdleTimeoutMs = Number.parseInt(
          process.env.INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS ?? '0',
          10,
        );
        let standaloneOwnerLastActivityAt = Date.now();
        const noteStandaloneOwnerActivity = (): void => {
          standaloneOwnerLastActivityAt = Date.now();
        };
        headlessDeps.isStandaloneOwnerIdle = () => {
          if (!Number.isFinite(standaloneOwnerIdleTimeoutMs) || standaloneOwnerIdleTimeoutMs <= 0) {
            return false;
          }
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

          switch (command) {
            case 'set': {
              const [, subCommand, targetArg] = payload.args;
              switch (subCommand) {
                case 'workflow':
                case 'merge-mode':
                  return {
                    workflowId: targetArg === undefined ? undefined : String(targetArg),
                    priority: 'high',
                  };
                case 'command':
                case 'prompt':
                case 'executor':
                case 'agent':
                case 'fix-prompt':
                case 'fix-context':
                case 'gate-policy':
                case 'task':
                  return {
                    workflowId: targetArg === undefined ? undefined : standaloneWorkflowIdForTaskArg(targetArg),
                    priority: 'high',
                  };
                default:
                  return { priority: 'normal' };
              }
            }
            case 'resume':
            case 'retry':
              return {
                workflowId: arg0 === undefined ? undefined : standaloneWorkflowIdForTaskArg(arg0),
                priority: 'high',
              };
            case 'recreate':
            case 'cancel-workflow':
              return { workflowId: arg0 === undefined ? undefined : String(arg0), priority: 'high' };
            case 'rebase-retry':
            case 'rebase-recreate':
              return { workflowId: standaloneWorkflowIdForTaskArg(arg0), priority: 'high' };
            case 'cancel':
            case 'retry-task':
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

        const standaloneWorkflowIdForTaskArg = (taskIdArg: unknown): string => {
          return resolveHeadlessTargetWorkflowId(taskIdArg, persistence);
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
        if (!workflowMutationDispatcher.has('invoker:fix-with-agent')) {
          workflowMutationDispatcher.set('invoker:fix-with-agent', async (...fixArgs: unknown[]) => {
            const { taskId, agentName, context } = parseFixWithAgentMutationArgs(fixArgs);
            const args = buildHeadlessFixArgs(taskId, agentName, context);
            await runHeadless(args, {
              ...headlessDeps,
              waitForApproval: false,
              noTrack: true,
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

        const buildStandaloneAutoFixQueueSnapshot = (taskId: string): Record<string, unknown> => {
          const workflowId = standaloneWorkflowIdForTaskArg(taskId);
          if (!workflowId) {
            return {
              workflowId: null,
              openIntentCountForWorkflow: 0,
              openFixIntentCountForWorkflow: 0,
              openFixIntentCountForTask: 0,
              openFixIntentForTask: false,
              openFixIntentHead: null,
              openFixIntentPreview: [],
            };
          }
          const openIntents = persistence.listWorkflowMutationIntents(workflowId, ['queued', 'running']);
          const openFixIntents = openIntents.filter((intent) => (
            intent.channel === 'invoker:fix-with-agent' || intent.channel === 'headless.exec'
          ));
          const openTaskFixIntents = listOpenFixIntentsForTask(openIntents, taskId);
          return {
            workflowId,
            openIntentCountForWorkflow: openIntents.length,
            openFixIntentCountForWorkflow: openFixIntents.length,
            openFixIntentCountForTask: openTaskFixIntents.length,
            openFixIntentForTask: openTaskFixIntents.length > 0,
            openFixIntentHead: openTaskFixIntents[0]
              ? {
                id: openTaskFixIntents[0].id,
                status: openTaskFixIntents[0].status,
                channel: openTaskFixIntents[0].channel,
              }
              : null,
            openFixIntentPreview: openTaskFixIntents.slice(0, 5).map((intent) => ({
              id: intent.id,
              status: intent.status,
              channel: intent.channel,
            })),
          };
        };

        const logStandaloneAutoFixDebug = (
          taskId: string,
          phase: string,
          details: Record<string, unknown> = {},
        ): void => {
          const task = orchestrator.getTask(taskId);
          const payload = {
            phase,
            status: task?.status ?? 'missing',
            autoFixAttempts: task?.execution.autoFixAttempts ?? null,
            ...buildStandaloneAutoFixQueueSnapshot(taskId),
            ...details,
          };
          persistence.logEvent?.(taskId, 'debug.auto-fix', payload);
          const recoveryAction = classifyAutoFixRecoveryPhase(phase, payload);
          if (recoveryAction) {
            persistence.logEvent?.(
              taskId,
              recoveryWorkerEventType(recoveryAction),
              buildRecoveryWorkerAuditPayload(recoveryAction, phase, payload),
            );
          }
          logger.info(
            `[auto-fix-debug][standalone] task="${taskId}" phase=${phase} payload=${JSON.stringify(payload)}`,
            { module: 'auto-fix' },
          );
        };

        const scheduleStandaloneAutoFix = (taskId: string): void => {
          logStandaloneAutoFixDebug(taskId, 'schedule-enter');
          if (!workflowMutationCoordinator) {
            logStandaloneAutoFixDebug(taskId, 'schedule-skip', { reason: 'no-workflow-mutation-coordinator' });
            return;
          }
          if (!workflowMutationDispatcher.has('invoker:fix-with-agent')) {
            logStandaloneAutoFixDebug(taskId, 'schedule-skip', { reason: 'fix-handler-not-ready' });
            return;
          }
          const workflowId = standaloneWorkflowIdForTaskArg(taskId);
          if (!workflowId) {
            logStandaloneAutoFixDebug(taskId, 'schedule-skip', { reason: 'workflow-not-found' });
            return;
          }
          const shouldAutoFixNow = orchestrator.shouldAutoFix(taskId);
          if (!shouldAutoFixNow) {
            logStandaloneAutoFixDebug(taskId, 'schedule-skip', {
              reason: 'shouldAutoFix-false',
              shouldAutoFix: shouldAutoFixNow,
            });
            return;
          }
          const openIntents = persistence.listWorkflowMutationIntents(workflowId, ['queued', 'running']);
          const openTaskFixIntents = listOpenFixIntentsForTask(openIntents, taskId);
          if (openTaskFixIntents.length > 0) {
            logStandaloneAutoFixDebug(taskId, 'schedule-skip', {
              reason: 'already-queued-intent',
              existingIntentIds: openTaskFixIntents.map((intent) => intent.id),
            });
            return;
          }
          const configuredAgent = loadConfig().autoFixAgent?.trim();
          const selectedAgent = configuredAgent && configuredAgent.length > 0 ? configuredAgent : undefined;
          logStandaloneAutoFixDebug(taskId, 'schedule-enqueue');
          logStandaloneAutoFixDebug(taskId, 'schedule-enqueued');
          void workflowMutationCoordinator.enqueue(
            workflowId,
            'normal',
            'invoker:fix-with-agent',
            buildFixWithAgentMutationArgs(taskId, selectedAgent, { autoFix: true }),
          )
            .then(() => {
              logStandaloneAutoFixDebug(taskId, 'schedule-dispatch-finished');
            })
            .catch((err) => {
              if (err instanceof StaleLineageError) {
                logger.info(`auto-fix discarded stale result for "${taskId}": ${err.message}`, { module: 'auto-fix' });
                return;
              }
              logStandaloneAutoFixDebug(taskId, 'schedule-dispatch-error', {
                error: err instanceof Error ? err.stack ?? err.message : String(err),
              });
            });
        };

        const maybeScheduleStandaloneAutoFix = (
          task: TaskState,
          trigger: 'delta' | 'poll',
        ): boolean => {
          if (task.status !== 'failed') return false;
          const cancellationError = shouldSkipAutoFixForError(task.execution.error);
          const shouldAutoFixFromOrchestrator = orchestrator.shouldAutoFix(task.id);
          logStandaloneAutoFixDebug(task.id, `${trigger}-failed`, {
            shouldSkipForCancellation: cancellationError,
            shouldAutoFixFromOrchestrator,
          });
          if (!cancellationError && shouldAutoFixFromOrchestrator) {
            logStandaloneAutoFixDebug(task.id, `${trigger}-trigger-schedule`);
            scheduleStandaloneAutoFix(task.id);
            return true;
          }
          logStandaloneAutoFixDebug(task.id, `${trigger}-skip`, {
            reason: cancellationError ? 'cancellation-error' : 'shouldAutoFix-false',
            shouldSkipForCancellation: cancellationError,
            shouldAutoFixFromOrchestrator,
          });
          return false;
        };

        const startStandaloneAutoFixRecoveryPoll = (workflowId: string): void => {
          const startedAtMs = Date.now();
          const maxPollMs = 90_000;
          const poll = setInterval(() => {
            if (Date.now() - startedAtMs > maxPollMs) {
              clearInterval(poll);
              return;
            }
            try {
              orchestrator.syncFromDb(workflowId);
              const scheduled = orchestrator
                .getAllTasks()
                .filter((task) => task.config.workflowId === workflowId)
                .some((task) => maybeScheduleStandaloneAutoFix(task, 'poll'));
              if (scheduled) {
                clearInterval(poll);
              }
            } catch (err) {
              logger.warn(
                `standalone auto-fix recovery poll failed for "${workflowId}": ${
                  err instanceof Error ? err.message : String(err)
                }`,
                { module: 'auto-fix' },
              );
            }
          }, 1_000);
          poll.unref?.();
        };

        messageBus.subscribe(Channels.TASK_DELTA, (delta: unknown) => {
          const d = delta as TaskDelta;
          if (d.type !== 'updated' || d.changes.status !== 'failed') return;
          const task = orchestrator.getTask(d.taskId);
          if (task) maybeScheduleStandaloneAutoFix(task, 'delta');
        });

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
          startStandaloneAutoFixRecoveryPoll(workflowId);
          logger.info(`started ${started.length} tasks for workflow "${workflowId}"`, { module: 'ipc-delegate' });
          const tasks = orchestrator.getAllTasks().filter(t => t.config.workflowId === workflowId);
          return { workflowId, tasks };
        };


        const executeStandaloneHeadlessResume = async (
          payload: HeadlessResumeMutationPayload,
        ): Promise<{ workflowId: string; tasks: TaskState[] }> => {
          const { workflowId } = payload;

          const allStarted = orchestrator.resumeWorkflow(workflowId);
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
          if (kind === 'workflow-status') {
            return orchestrator.getWorkflowStatus();
          }
          if (kind === 'tasks' || kind === 'task-graph-refresh') {
            if (kind === 'task-graph-refresh') {
              orchestrator.syncAllFromDb();
            }
            return {
              tasks: orchestrator.getAllTasks(),
              workflows: persistence.listWorkflows(),
              streamSequence: 0,
              invokerHomeRoot: resolveInvokerHomeRoot(),
            };
          }
          if (kind === 'action-graph') {
            return buildCurrentActionGraphSnapshot({ orchestrator, persistence, invokerConfig });
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
          const payload: HeadlessExecMutationPayload = {
            args,
            waitForApproval: delegatedWait,
            noTrack: delegatedNoTrack,
            traceId,
          };
          logHeadlessExecReceived(payload, 'standalone');
          const { workflowId, priority } = classifyStandaloneHeadlessExecMutation(payload);
          const acknowledgement = acknowledgeNoTrackHeadlessExec(payload, workflowId, priority, 'standalone');
          if (acknowledgement) return acknowledgement;
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
        messageBus.onRequest('headless.gui-mutation', async (req: unknown) => {
          noteStandaloneOwnerActivity();
          return executeStandaloneGuiMutation(req as GuiMutationPayload);
        });

        lifecycleEventBridge = startLifecycleEventBridge({
          messageBus,
          getInitialTasks: () => orchestrator.getAllTasks(),
          getTask: (taskId) => orchestrator.getTask(taskId),
          logger,
        });

        reviewGateStatusWorker = startReviewGateStatusWorker({
          ownerMode: true,
          getTaskExecutor: createStandaloneTaskExecutor,
          logger,
        });

        // Owner discovery and exec handlers must exist before dispatch polling starts.
        if (!readOnlyMode) {
          standaloneLaunchDispatcherController = startStandaloneLaunchDispatcher({
            headlessDeps,
            ownerId: workflowMutationOwnerId,
            createTaskExecutor: createStandaloneTaskExecutor,
            setLatestTaskExecutor: (executor) => { latestTaskExecutor = executor; },
          });
        }
      }

      await runHeadless(cliArgs, headlessDeps);
    } catch (err) {
      process.stderr.write(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
      exitCode = 1;
    } finally {
      standaloneLaunchDispatcherController?.stop();
      lifecycleEventBridge?.stop();
      reviewGateStatusWorker?.stop();
      if (ownsHeadlessShutdown && executorRegistry) {
        await Promise.all(executorRegistry.getAll().map(f => f.destroyAll().catch(() => undefined)));
      }
      if (ownsHeadlessShutdown && orchestrator) {
        for (const task of orchestrator.getAllTasks()) {
          if (isTaskInFlightForForcedStop(task)) {
            if (persistence) {
              persistShutdownDiagnostic(task, persistence, { forcedStopReason: 'Application quit' });
            }
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
      if (ownsHeadlessShutdown && persistence) {
        persistence.requeueRunningWorkflowMutationIntents();
      }
      if (persistence) persistence.close();
      if (writerLock) writerLock.release();
      if (messageBus) messageBus.disconnect();
    }
    process.exit(exitCode);
  };

  runElectronReadyBootstrap({
    app,
    run: runHeadlessMain,
    onError: (err) => {
      process.stderr.write(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  });
}

startMainProcessBootstrap({
  isHeadless,
  startHeadlessMode,
  startGuiMode: () => startGuiModeBootstrap({
    app,
    isTest: process.env.NODE_ENV === 'test',
    acquireGuiLock: () => {
      guiInstanceLock = tryAcquireGuiInstanceLock(resolveInvokerHomeRoot());
      return guiInstanceLock;
    },
    notifyGuiAlreadyRunning: () => {
      dialog.showErrorBox(
        'Invoker is already running',
        'Only one Invoker GUI can run for this Invoker home. Use the existing window, or close it before opening another one.',
      );
    },
    setupGuiMode,
  }),
});

// ══════════════════════════════════════════════════════════════
// GUI MODE
// ══════════════════════════════════════════════════════════════

function createEmbeddedTerminalBackendFromConfig(
  backend: EmbeddedTerminalBackendConfig,
): EmbeddedTerminalBackend {
  // E2E fault injection: reproduce node-pty's synchronous spawn throw (e.g.
  // a spawn-helper binary without its exec bit) without mutating the shared
  // node_modules that parallel tests rely on.
  if (process.env.INVOKER_E2E_BREAK_TERMINAL_SPAWN === '1') {
    return {
      name: 'pty',
      spawn() {
        throw new Error('posix_spawnp failed. (injected by INVOKER_E2E_BREAK_TERMINAL_SPAWN)');
      },
    };
  }
  if (backend === 'bash') return createBashTerminalBackend();
  return createPtyTerminalBackend();
}

  function setupGuiMode(): void {
  const agentRegistry = registerBuiltinAgents();
  let mainWindow: BrowserWindow | null = null;
  let taskExecutor: TaskRunner | null = null;
  let reviewGateStatusWorker: ReviewGateStatusWorker | null = null;
  let apiServer: ApiServer | null = null;
  let webBridge: WebBridge | null = null;
  let ownerMode = true;
  const taskHandles: TaskHandleMap = new Map();
  const embeddedTerminalManager = new EmbeddedTerminalManager({
    backend: createEmbeddedTerminalBackendFromConfig(resolveEmbeddedTerminalBackendConfig(invokerConfig)),
  });
  embeddedTerminalManager.on('output', (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('invoker:terminal-output', payload);
    }
  });
  embeddedTerminalManager.on('exit', (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('invoker:terminal-exit', payload);
    }
  });
  // CC.5: the legacy `launchingTasks` Set is gone. Per-attempt launch
  // state is tracked durably by `task_launch_dispatch` (Phase B); the
  // TaskRunner's internal `launchingAttemptIds` Set (CB.4) is the
  // process-local duplicate-suppression guard. The renderer's
  // `activeExecutions` count now just reflects spawned execution
  // handles in `taskHandles`.
  const guiMutationHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  let dbPollInterval: ReturnType<typeof setInterval> | null = null;
  let activityPollInterval: ReturnType<typeof setInterval> | null = null;
  let uiPerfLogInterval: ReturnType<typeof setInterval> | null = null;
  const lastKnownTaskStates = new TaskSnapshotCache();
  const workflowRollupProjection = new WorkflowRollupProjection();
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
  let workflowMetadataPublisher: CoalescedWorkflowMetadataPublisher | null = null;
  let lastKnownWorkflowCount = 0;
  let lastActivityLogId = 0;
  let startupWorkflowId: string | null = null;
  let uiInteractive = false;
  let deferredStartupTriggered = false;
  const traceUiDeltaFlow = process.env.INVOKER_TRACE_UI_DELTA === '1';
  const traceDbPollPerTask = process.env.INVOKER_TRACE_DB_POLL === '1';
  const traceTaskOutput = process.env.INVOKER_TRACE_TASK_OUTPUT === '1';
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
    workflowMetadataPublishRequests: 0,
    workflowMetadataPublishes: 0,
    workflowMetadataCoalescedRequests: 0,
    largeTaskDeltaBatches: 0,
    maxTaskDeltaBatchSize: 0,
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
    uiPerfStats.workflowMetadataPublishRequests = 0;
    uiPerfStats.workflowMetadataPublishes = 0;
    uiPerfStats.workflowMetadataCoalescedRequests = 0;
    uiPerfStats.largeTaskDeltaBatches = 0;
    uiPerfStats.maxTaskDeltaBatchSize = 0;
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
      // Runner stream chunks land in the output spool only — task_output is
      // reserved for explicit diagnostic writes (workflow actions, shutdown).
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

  const taskDeltaStream = createTaskDeltaStreamSequence();
  const getTaskDeltaStreamSequence = (): number => taskDeltaStream.current();


  const taskGraphEventPublisher = createTaskGraphEventPublisher({
    getMainWindow: () => mainWindow,
    isUiInteractive: () => uiInteractive,
    stampDelta: (delta) => taskDeltaStream.stamp(delta),
    getStreamSequence: getTaskDeltaStreamSequence,
    onLargeBatch: ({ batchSize, remaining }) => {
      uiPerfStats.largeTaskDeltaBatches += 1;
      uiPerfStats.maxTaskDeltaBatchSize = Math.max(uiPerfStats.maxTaskDeltaBatchSize, batchSize);
      logger.info(`large task-graph-event batch chunked size=${batchSize} remaining=${remaining}`, {
        module: 'ui-backpressure',
      });
    },
    onEvent: (event) => webBridge?.broadcast('invoker:task-graph-event', event),
  });

  const publishTaskDeltaToRenderer = (delta: TaskDelta): void => {
    const workflowRollups = workflowRollupProjection.applyDelta(delta);
    taskGraphEventPublisher.publishDelta(delta, workflowRollups);
  };

  const applyTaskDeltaToOwnerCacheOrRecover = (delta: TaskDelta): TaskDelta[] => {
    const { quarantined, accepted } = applyDelta(delta, lastKnownTaskStates);
    if (quarantined.length === 0) {
      return accepted ? [delta] : [];
    }

    const rendererDeltas: TaskDelta[] = [];
    for (const taskId of quarantined) {
      logger.info(`[gap-detect] quarantined task="${taskId}" — triggering authoritative reload`, { module: 'delta-merge' });
      const { rendererDelta } = recoverQuarantinedTask(lastKnownTaskStates, taskId, {
        loadTask: loadTaskByIdFromPersistence,
        getMergeNode: (workflowId) => orchestrator.getMergeNode(workflowId),
      });
      if (rendererDelta) {
        rendererDeltas.push(rendererDelta);
      }
    }
    return rendererDeltas;
  };

  const requestWorkflowMetadataPublish = (reason: string): void => {
    uiPerfStats.workflowMetadataPublishRequests += 1;
    workflowMetadataPublisher?.requestPublish(reason);
  };

  const buildAutoFixQueueSnapshot = (taskId: string): Record<string, unknown> => {
    const workflowId = workflowIdForTaskArg(taskId);
    if (!workflowId) {
      return {
        workflowId: null,
        openIntentCountForWorkflow: 0,
        openFixIntentCountForWorkflow: 0,
        openFixIntentCountForTask: 0,
        openFixIntentForTask: false,
        openFixIntentHead: null,
        openFixIntentPreview: [],
      };
    }
    const openIntents = persistence.listWorkflowMutationIntents(workflowId, ['queued', 'running']);
    const openFixIntents = openIntents.filter((intent) => (
      intent.channel === 'invoker:fix-with-agent' || intent.channel === 'headless.exec'
    ));
    const openTaskFixIntents = listOpenFixIntentsForTask(openIntents, taskId);
    return {
      workflowId,
      openIntentCountForWorkflow: openIntents.length,
      openFixIntentCountForWorkflow: openFixIntents.length,
      openFixIntentCountForTask: openTaskFixIntents.length,
      openFixIntentForTask: openTaskFixIntents.length > 0,
      openFixIntentHead: openTaskFixIntents[0]
        ? {
          id: openTaskFixIntents[0].id,
          status: openTaskFixIntents[0].status,
          channel: openTaskFixIntents[0].channel,
        }
        : null,
      openFixIntentPreview: openTaskFixIntents.slice(0, 5).map((intent) => ({
        id: intent.id,
        status: intent.status,
        channel: intent.channel,
      })),
    };
  };

  const logAutoFixDebug = (
    taskId: string,
    phase: string,
    details: Record<string, unknown> = {},
  ): void => {
    const task = orchestrator.getTask(taskId);
    const payload = {
      phase,
      status: task?.status ?? 'missing',
      autoFixAttempts: task?.execution.autoFixAttempts ?? null,
      ...buildAutoFixQueueSnapshot(taskId),
      ...details,
    };
    persistence.logEvent?.(taskId, 'debug.auto-fix', payload);
    const recoveryAction = classifyAutoFixRecoveryPhase(phase, payload);
    if (recoveryAction) {
      persistence.logEvent?.(
        taskId,
        recoveryWorkerEventType(recoveryAction),
        buildRecoveryWorkerAuditPayload(recoveryAction, phase, payload),
      );
    }
    logger.info(
      `[auto-fix-debug] task="${taskId}" phase=${phase} payload=${JSON.stringify(payload)}`,
      { module: 'auto-fix' },
    );
  };

  const executeFixWithAgentMutation = async (
    taskId: string,
    agentName?: string,
    source: 'ipc' | 'auto-fix' = 'ipc',
  ): Promise<TaskState[]> => {
    const task = orchestrator.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    const savedError = task.execution.error ?? '';
    const recoveryRoute = selectFailureRecoveryRoute(task, savedError);
    logger.info(
      `fix-with-agent: "${taskId}" agent=${agentName ?? 'claude'} source=${source} route=${recoveryRoute.kind}`,
      { module: 'ipc' },
    );

    if (source === 'auto-fix') {
      const attemptsBefore = task?.execution.autoFixAttempts ?? 0;
      const attemptsAfter = attemptsBefore + 1;
      persistence.updateTask(taskId, {
        execution: {
          autoFixAttempts: attemptsAfter,
        },
      });
      logAutoFixDebug(taskId, 'dispatch-attempt-bumped', { attemptsBefore, attemptsAfter });
    }
    const result = await fixWithAgentAction(
      taskId,
      {
        logger,
        orchestrator,
        persistence,
        commandService,
        taskExecutor: requireTaskExecutor(),
        mutationTiming: activeMutationContext?.mutationTiming,
        autoApproveAIFixes: invokerConfig.autoApproveAIFixes,
      },
      {
        agentName,
        recoveryRoute,
        recreateOutputLabel: source === 'auto-fix' ? 'Auto-fix' : 'Fix with AI',
        failureOutputLabel: source === 'auto-fix' ? 'Auto-fix' : `Fix with ${agentName ?? 'Claude'}`,
        signal: activeMutationContext?.signal,
      },
    );
    return result.started;
  };

  const scheduleAutoFix = (taskId: string): void => {
    logAutoFixDebug(taskId, 'schedule-enter');
    if (!workflowMutationCoordinator) {
      logAutoFixDebug(taskId, 'schedule-skip', { reason: 'no-workflow-mutation-coordinator' });
      return;
    }
    if (!workflowMutationDispatcher.has('invoker:fix-with-agent')) {
      logAutoFixDebug(taskId, 'schedule-skip', { reason: 'fix-handler-not-ready' });
      return;
    }
    const workflowId = workflowIdForTaskArg(taskId);
    if (!workflowId) {
      logAutoFixDebug(taskId, 'schedule-skip', { reason: 'workflow-not-found' });
      return;
    }
    const shouldAutoFixNow = orchestrator.shouldAutoFix(taskId);
    if (!shouldAutoFixNow) {
      logAutoFixDebug(taskId, 'schedule-skip', {
        reason: 'shouldAutoFix-false',
        shouldAutoFix: shouldAutoFixNow,
      });
      return;
    }
    const openIntents = persistence.listWorkflowMutationIntents(workflowId, ['queued', 'running']);
    const openTaskFixIntents = listOpenFixIntentsForTask(openIntents, taskId);
    if (openTaskFixIntents.length > 0) {
      logAutoFixDebug(taskId, 'schedule-skip', {
        reason: 'already-queued-intent',
        existingIntentIds: openTaskFixIntents.map((intent) => intent.id),
      });
      return;
    }
    const configuredAgent = loadConfig().autoFixAgent?.trim();
    const selectedAgent = configuredAgent && configuredAgent.length > 0 ? configuredAgent : undefined;
    logAutoFixDebug(taskId, 'schedule-enqueue');
    logAutoFixDebug(taskId, 'schedule-enqueued');
    void runWorkflowMutation(
      workflowId,
      'normal',
      'invoker:fix-with-agent',
      [taskId, selectedAgent],
      async () => executeFixWithAgentMutation(taskId, selectedAgent, 'auto-fix'),
    )
      .then(() => {
        logAutoFixDebug(taskId, 'schedule-dispatch-finished');
      })
      .catch((err) => {
        if (err instanceof StaleLineageError) {
          logger.info(`auto-fix discarded stale result for "${taskId}": ${err.message}`, { module: 'auto-fix' });
          return;
        }
        logAutoFixDebug(taskId, 'schedule-dispatch-error', {
          error: err instanceof Error ? err.stack ?? err.message : String(err),
        });
      });
  };

  const parseExecutionDate = (value: unknown): Date | undefined => {
    if (!value) return undefined;
    if (value instanceof Date) return value;
    if (typeof value !== 'string') return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  };

  function assertFatalExecutionCapacity(label: string): void {
    if (!shouldFatalOnExecutionCapacityOvercommit()) return;
    try {
      assertExecutionCapacityInvariant({
        config: loadConfig(),
        activeExecutions: taskHandles.size,
        label,
      });
    } catch (err) {
      logger.error(err instanceof Error ? err.stack ?? err.message : String(err), { module: 'exec' });
      setImmediate(() => {
        throw err;
      });
      throw err;
    }
  }

  registerMainWindowSecondInstanceHandler({
    app,
    getMainWindow: () => mainWindow,
  });

  function rebuildTaskRunner(): void {
    rebuildTaskRunnerWiring({
      orchestrator,
      persistence,
      executorRegistry,
      executionAgentRegistry: agentRegistry,
      repoRoot,
      invokerConfig,
      logger,
      messageBus,
      taskHandles,
      enqueueTaskOutput,
      flushTaskOutput,
      assertFatalExecutionCapacity,
      getTaskRunner: () => taskExecutor,
      setTaskRunner: (runner) => { taskExecutor = runner; },
      setLatestTaskExecutor: (runner) => { latestTaskExecutor = runner; },
    });
  }

  async function killRunningTask(taskId: string): Promise<void> {
    await killRunningTaskExecution({
      getTaskRunner: () => taskExecutor,
      logger,
      taskHandles,
    }, taskId);
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
    await requireTaskExecutor().closeWorkflowReview(workflowId);
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
    return requireWiredTaskRunner(() => taskExecutor);
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
    logger.info(`started ${started.length} tasks for workflow "${workflowId}"`, { module: 'ipc-delegate' });
    const tasks = orchestrator.getAllTasks().filter(t => t.config.workflowId === workflowId);
    return { workflowId, tasks };
  }

  async function executeHeadlessResume(payload: HeadlessResumeMutationPayload): Promise<{ workflowId: string; tasks: TaskState[] }> {
    const { workflowId } = payload;

    const allStarted = orchestrator.resumeWorkflow(workflowId);
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
        logger.info(
          `deferRunnableTasks accepted by launch outbox workflow="${workflowId ?? 'unknown'}" count=${filteredTasks.length}`,
          { module: 'ipc-delegate' },
        );
        return;
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
      case 'set': {
        const [, subCommand, targetArg] = payload.args;
        switch (subCommand) {
          case 'workflow':
          case 'merge-mode':
            return { workflowId: targetArg === undefined ? undefined : String(targetArg), priority: 'high' };
          case 'command':
          case 'prompt':
          case 'executor':
          case 'agent':
          case 'fix-prompt':
          case 'fix-context':
          case 'gate-policy':
          case 'task':
            return { workflowId: workflowIdForTaskArg(targetArg), priority: 'high' };
          default:
            return { priority: 'normal' };
        }
      }
      case 'resume':
      case 'retry':
        return { workflowId: workflowIdForTargetArg(arg0), priority: 'high' };
      case 'recreate':
      case 'cancel-workflow':
      case 'delete':
      case 'delete-workflow':
        return { workflowId: arg0, priority: 'high' };
      case 'rebase-retry':
      case 'rebase-recreate':
        return { workflowId: workflowIdForTargetArg(arg0), priority: 'high' };
      case 'cancel':
      case 'retry-task':
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

  function submitWorkflowMutation(
    workflowId: string | undefined,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
  ): WorkflowMutationAcceptedResult {
    if (!workflowId) throw new Error(`Could not resolve workflow for ${channel}`);
    if (!workflowMutationCoordinator) throw new Error('Workflow mutation coordinator is unavailable');
    if (!workflowMutationDispatcher.has(channel)) {
      throw new Error(`No workflow mutation dispatcher registered for ${channel}`);
    }
    const intentId = workflowMutationCoordinator.submit(workflowId, priority, channel, args);
    return { ok: true, accepted: true, intentId, workflowId, channel };
  }

  function registerTaskScopedGuiMutationHandler<TResult = unknown>(
    channel: keyof typeof IpcChannels & string,
    resolveWorkflowId: (...args: unknown[]) => string | undefined,
    priority: WorkflowMutationPriority,
    handler: (...args: unknown[]) => Promise<TResult>,
  ): void {
    workflowMutationDispatcher.set(channel, (...args: unknown[]) => handler(...args));
    registerGuiMutationHandler(channel, async (...args: unknown[]) => (
      submitWorkflowMutation(resolveWorkflowId(...args), priority, channel, args)
    ));
  }

  function translateGuiMutationToHeadless(payload: GuiMutationPayload):
    | { channel: 'headless.gui-mutation'; request: GuiMutationPayload }
    | { channel: 'headless.run'; request: HeadlessRunMutationPayload }
    | { channel: 'headless.resume'; request: HeadlessResumeMutationPayload }
    | { channel: 'headless.exec'; request: HeadlessExecMutationPayload }
    | null {
    const [arg0, arg1, arg2] = payload.args;
    switch (payload.channel) {
      case 'invoker:load-plan':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:start':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:stop':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:clear':
        return { channel: 'headless.gui-mutation', request: payload };
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
        return { channel: 'headless.exec', request: { args: ['delete', String(arg0)], noTrack: true } };
      case 'invoker:detach-workflow':
        return { channel: 'headless.exec', request: { args: ['detach-workflow', String(arg0), String(arg1)], noTrack: true } };
      case 'invoker:provide-input':
        return { channel: 'headless.exec', request: { args: ['input', String(arg0), String(arg1)], noTrack: true } };
      case 'invoker:approve':
        return { channel: 'headless.exec', request: { args: ['approve', String(arg0)], noTrack: true } };
      case 'invoker:reject':
        return arg1 === undefined
          ? { channel: 'headless.exec', request: { args: ['reject', String(arg0)], noTrack: true } }
          : { channel: 'headless.exec', request: { args: ['reject', String(arg0), String(arg1)], noTrack: true } };
      case 'invoker:select-experiment':
        if (Array.isArray(arg1)) return null;
        return { channel: 'headless.exec', request: { args: ['select', String(arg0), String(arg1)], noTrack: true } };
      case 'invoker:restart-task':
        return { channel: 'headless.exec', request: { args: ['retry-task', String(arg0)], noTrack: true } };
      case 'invoker:cancel-task':
        return { channel: 'headless.exec', request: { args: ['cancel', String(arg0)], noTrack: true } };
      case 'invoker:cancel-workflow':
        return { channel: 'headless.exec', request: { args: ['cancel-workflow', String(arg0)], noTrack: true } };
      case 'invoker:recreate-workflow':
        return { channel: 'headless.exec', request: { args: ['recreate', String(arg0)], noTrack: true } };
      case 'invoker:recreate-task':
        return { channel: 'headless.exec', request: { args: ['recreate-task', String(arg0)], noTrack: true } };
      case 'invoker:recreate-downstream':
        return { channel: 'headless.exec', request: { args: ['recreate-downstream', String(arg0)], noTrack: true } };
      case 'invoker:retry-workflow':
        return { channel: 'headless.exec', request: { args: ['retry', String(arg0)], noTrack: true } };
      case 'invoker:rebase-retry':
        return { channel: 'headless.exec', request: { args: ['rebase-retry', String(arg0)], noTrack: true } };
      case 'invoker:rebase-recreate':
        return { channel: 'headless.exec', request: { args: ['rebase-recreate', String(arg0)], noTrack: true } };
      case 'invoker:set-merge-branch':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:set-merge-mode':
        return { channel: 'headless.exec', request: { args: ['set', 'merge-mode', String(arg0), String(arg1)], noTrack: true } };
      case 'invoker:approve-merge': {
        const workflowId = String(arg0);
        const mergeTask = persistence.loadTasks(workflowId).find((task) => task.config.isMergeNode);
        if (!mergeTask) return null;
        return { channel: 'headless.exec', request: { args: ['approve', mergeTask.id], noTrack: true } };
      }
      case 'invoker:check-pr-statuses':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:check-pr-status':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:resolve-conflict':
        return arg1 === undefined
          ? { channel: 'headless.exec', request: { args: ['resolve-conflict', String(arg0)], noTrack: true } }
          : { channel: 'headless.exec', request: { args: ['resolve-conflict', String(arg0), String(arg1)], noTrack: true } };
      case 'invoker:fix-with-agent': {
        const { taskId, agentName, context } = parseFixWithAgentMutationArgs(payload.args);
        return { channel: 'headless.exec', request: { args: buildHeadlessFixArgs(taskId, agentName, context), noTrack: true } };
      }
      case 'invoker:edit-task-command':
        return { channel: 'headless.exec', request: { args: ['set', 'command', String(arg0), String(arg1)], noTrack: true } };
      case 'invoker:edit-task-prompt':
        return { channel: 'headless.exec', request: { args: ['set', 'prompt', String(arg0), String(arg1)], noTrack: true } };
      case 'invoker:edit-task-type':
        return { channel: 'headless.exec', request: { args: ['set', 'executor', String(arg0), String(arg1)], noTrack: true } };
      case 'invoker:edit-task-pool':
        return null;
      case 'invoker:edit-task-agent':
        return { channel: 'headless.exec', request: { args: ['set', 'agent', String(arg0), String(arg1)], noTrack: true } };
      case 'invoker:set-task-external-gate-policies': {
        const taskId = String(arg0);
        const updates = Array.isArray(arg1) ? arg1 as Array<{ workflowId: string; taskId?: string; gatePolicy: 'completed' | 'review_ready' }> : [];
        if (updates.length !== 1) return null;
        const update = updates[0];
        if (!update) return null;
        const args = ['set', 'gate-policy', taskId, update.workflowId];
        if (update.taskId) args.push(update.taskId);
        args.push(update.gatePolicy);
        return { channel: 'headless.exec', request: { args, noTrack: true } };
      }
      case 'invoker:replace-task':
        return {
          channel: 'headless.exec',
          request: { args: ['replace-task', String(arg0), JSON.stringify(Array.isArray(arg1) ? arg1 : [])], noTrack: true },
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

  const guiMutationRegistrationContext: GuiMutationRegistrationContext = {
    ipcMain,
    getOwnerMode: () => ownerMode,
    getMessageBus: () => messageBus,
    refreshOwnerRoute: refreshGuiMutationOwnerRoute,
    translateGuiMutationToHeadless,
    guiMutationHandlers,
  };

  const workflowScopedGuiMutationRegistrationContext: WorkflowScopedGuiMutationRegistrationContext = {
    ...guiMutationRegistrationContext,
    workflowMutationDispatcher,
    submitWorkflowMutation,
  };

  const {
    registerGuiMutationHandler,
    registerWorkflowScopedGuiMutationHandler,
  } = createGuiMutationRegistrars(
    guiMutationRegistrationContext,
    workflowScopedGuiMutationRegistrationContext,
  );

  function createWindow(): void {
    createMainWindow({
      appRootDir: __dirname,
      invokerConfig,
      logger,
      hideE2eWindow,
      enableTestCompositor,
      recordStartupMark,
      setUiInteractive: (value) => { uiInteractive = value; },
      startDeferredStartupWork,
      setMainWindow: (window) => { mainWindow = window; },
    });
  }

  function seedUiSnapshotCache(): void {
    lastKnownWorkflowCount = persistence.listWorkflows().length;
    const tasks = orchestrator.getAllTasks();
    lastKnownTaskStates.clear();
    workflowRollupProjection.replaceAll(tasks);
    for (const task of tasks) {
      lastKnownTaskStates.set(task.id, JSON.stringify(task));
    }
  }

  function loadTaskByIdFromPersistence(taskId: string): TaskState | undefined {
    return persistence.loadTask(taskId);
  }

  workflowMetadataPublisher = new CoalescedWorkflowMetadataPublisher({
    listWorkflows: () => persistence.listWorkflows(),
    publish: (workflows, stats) => {
      lastKnownWorkflowCount = workflows.length;
      uiPerfStats.workflowMetadataPublishes += 1;
      uiPerfStats.workflowMetadataCoalescedRequests += Math.max(0, stats.coalescedRequests - 1);
      if (stats.coalescedRequests > 1) {
        logger.info(
          `coalesced workflow metadata publish requests=${stats.coalescedRequests} workflows=${workflows.length}`,
          { module: 'ui-backpressure', reasonCounts: stats.reasonCounts },
        );
      }
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
    workflowRollupProjection.replaceAll(tasks);
    for (const task of tasks) {
      const snapshot = JSON.stringify(task);
      previousTaskIds.delete(task.id);
      lastKnownTaskStates.set(task.id, snapshot);
      if (mainWindow && !mainWindow.isDestroyed()) {
        publishTaskDeltaToRenderer({ type: 'created', task });
      }
    }
    lastKnownWorkflowCount = workflows.length;
    if (mainWindow && !mainWindow.isDestroyed()) {
      for (const removedTaskId of previousTaskIds) {
        publishTaskDeltaToRenderer({ type: 'removed', taskId: removedTaskId, previousTaskStateVersion: 0 });
      }
      requestWorkflowMetadataPublish('orchestrator-snapshot');
    }
  }

  function startDeferredStartupWork(): void {
    if (deferredStartupTriggered) return;
    deferredStartupTriggered = true;
    recordStartupMark('deferred-startup.begin');
    const configuredStartupPollDelayMs = Number.parseInt(process.env.INVOKER_STARTUP_POLL_DELAY_MS ?? '10000', 10);
    const startupPollDelayMs = Number.isFinite(configuredStartupPollDelayMs)
      ? configuredStartupPollDelayMs
      : 10000;

    setTimeout(() => {
      if (!ownerMode) return;

      const webMutations = new WorkflowMutationFacade({
        logger,
        orchestrator,
        persistence,
        commandService,
        taskExecutor: requireTaskExecutor(),
        autoApproveAIFixes: invokerConfig.autoApproveAIFixes,
        killRunningTask,
      });
      apiServer = startApiServer({
        logger,
        orchestrator,
        persistence,
        executorRegistry,
        mutations: webMutations,
        queueWorkflowMutation: (workflowId, priority, channel, args, options) => {
          if (!workflowMutationCoordinator) {
            throw new Error('Workflow mutation coordinator is unavailable');
          }
          return workflowMutationCoordinator.submit(workflowId, priority, channel, args, options);
        },
        deleteWorkflow: performDeleteWorkflow,
        detachWorkflow: performDetachWorkflow,
      });
      recordStartupMark('api-server.started');

      const webToken = resolveWebToken(invokerConfig);
      if (webToken) {
        const webDispatch = buildWebInvokerDispatch({
          orchestrator,
          persistence,
          mutations: webMutations,
          agentRegistry,
          loadConfig,
          getStreamSequence: getTaskDeltaStreamSequence,
          refreshTaskGraph: async () => {
            const snapshot = await resolveRefreshTaskGraphSnapshot({
              ownerMode,
              messageBus,
              resolveInvokerHomeRoot,
              orchestrator,
              persistence,
              logger,
            });
            taskGraphEventPublisher.publishSnapshot('refresh-task-graph', snapshot.tasks, snapshot.workflows);
          },
          deleteWorkflow: performDeleteWorkflow,
          detachWorkflow: performDetachWorkflow,
          getBundledSkillsStatus,
          getSystemDiagnostics: () => collectSystemDiagnostics({
            appVersion: app.getVersion(),
            isPackaged: app.isPackaged,
            platform: process.platform,
            arch: process.arch,
          }),
          logger,
        });
        webBridge = startWebBridge({
          logger,
          dispatch: webDispatch,
          messageBus,
          persistence,
          uiDistDir: resolveWebUiDistDir(__dirname),
          token: webToken,
          host: resolveWebHost(invokerConfig),
          port: resolveWebPort(invokerConfig),
        });
      } else {
        logger.info('Web surface disabled — set INVOKER_WEB_TOKEN (or config.webToken) to enable it', { module: 'web-bridge' });
      }

      void recoverWorkflowMutationsOnStartup({
        ownerMode,
        persistence,
        workflowMutationCoordinator: workflowMutationCoordinator ?? undefined,
        logger,
        maybeDelayResume: maybeDelayWorkflowResumeForTest,
      });

      // .env is loaded synchronously at startup; skip Slack only when required vars are still missing.
      const slackEnvVars = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_CHANNEL_ID'];
      const slackEnvMissing = slackEnvVars.filter((v) => !process.env[v]);
      if (slackEnvMissing.length > 0) {
        logger.info(`Slack bot not started — missing env: ${slackEnvMissing.join(', ')}. Run \`invoker-cli setup slack\` or set them in ~/.invoker/.env`, { module: 'slack' });
      } else {
        for (const check of runStartupPrerequisites(
          invokerConfig.slackHarnessPresets ?? DEFAULT_SLACK_HARNESS_PRESETS,
          invokerConfig.defaultSlackHarnessPreset ?? 'cursor+claude',
        )) {
          logger.warn(`Prerequisites — ${check.name}: ${check.detail}${check.remediation ? ` (${check.remediation})` : ''}`, { module: 'prerequisites' });
        }
        startSlackBot(requireTaskExecutor(), taskHandles).catch((err) => {
          logger.info(`Not started: ${err instanceof Error ? err.message : String(err)}`, { module: 'slack' });
        });
      }

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
              requestWorkflowMetadataPublish('db-poll-count');

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
                  // CC.1: launch-stall watchdog removed. The
                  // LaunchDispatcher's reapExpiredLeases /
                  // abandonStuckLeases reapers (Phase B, CB.3) are the
                  // sole recovery path for stalled launch claims.
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
                    const selectedAttemptHeartbeat = parseExecutionDate(selectedAttempt?.lastHeartbeatAt);
                    const executingError =
                      `Execution stalled: task remained in running/executing for ${Math.floor(executingAgeMs / 1000)}s ` +
                      `without a live execution handle and no completion signal from executor (${staleReason}).`;
                    logger.info(
                      `[executing-stall] detected task="${task.id}" phase=${task.execution.phase} executingAgeMs=${executingAgeMs} ` +
                        `handlePresent=${taskHandles.has(task.id)} leaseExpired=${leaseExpired} heartbeatStale=${heartbeatStale} ` +
                        `runnerKind=${task.config.runnerKind ?? 'none'} selectedAttemptId=${task.execution.selectedAttemptId ?? 'none'} ` +
                        `attemptStatus=${selectedAttempt?.status ?? 'none'} executorHeartbeatAt=${previousHeartbeat?.toISOString() ?? 'none'} ` +
                        `remoteHeartbeatAt=${remoteHeartbeat?.toISOString() ?? 'none'} attemptHeartbeatAt=${selectedAttemptHeartbeat?.toISOString() ?? 'none'} ` +
                        `leaseExpiresAt=${leaseExpiresAt?.toISOString() ?? 'none'} launchStartedAt=${task.execution.launchStartedAt instanceof Date ? task.execution.launchStartedAt.toISOString() : task.execution.launchStartedAt ?? 'none'} ` +
                        `launchCompletedAt=${task.execution.launchCompletedAt instanceof Date ? task.execution.launchCompletedAt.toISOString() : task.execution.launchCompletedAt ?? 'none'} ` +
                        `startedAt=${executingStartedAt?.toISOString() ?? 'none'} completedAt=${task.execution.completedAt instanceof Date ? task.execution.completedAt.toISOString() : task.execution.completedAt ?? 'none'}`,
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
                    if (persistence) {
                      persistShutdownDiagnostic(task, persistence, {
                        flushPendingOutput: flushTaskOutput,
                        forcedStopReason: executingError,
                        label: task.execution.phase === 'launching'
                          ? 'Startup Failure Diagnostic'
                          : 'Shutdown Diagnostic',
                      });
                    }
                    orchestrator.handleWorkerResponse(failedResponse);
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
                  publishTaskDeltaToRenderer({ type: 'created', task });
                } else if (prev !== snapshot) {
                  if (traceDbPollPerTask) {
                    const msg = `Task updated: ${task.id} (${task.status})`;
                    logger.info(msg, { module: 'db-poll' });
                    try { persistence.writeActivityLog('db-poll', 'info', msg); } catch { /* db locked */ }
                  }
                  lastKnownTaskStates.set(task.id, snapshot);
                  uiPerfStats.dbPollUpdatedAsCreated += 1;
                  publishTaskDeltaToRenderer({ type: 'created', task });
                }
              }
            }
            if (launchDispatcher) {
              try {
                launchDispatcher.poll();
              } catch (err) {
                logger.warn(
                  `[launch-dispatcher] poll() failed: ${err instanceof Error ? err.message : String(err)}`,
                  { module: 'db-poll' },
                );
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

  const runGuiReadyBootstrap = async (): Promise<void> => {
    recordStartupMark('app.whenReady');
    // GUI owner modes:
    // - daemon: GUI is a client; a background daemon owns workflow writes, and startup failure is serious.
    // - gui/local: GUI owns workflow writes directly with no daemon.
    // - auto: GUI uses an existing daemon when one is available, otherwise it runs locally as owner.
    const guiOwnerPreference = resolveGuiOwnerPreference();
    let daemonGuiOwner = false;
    if (guiOwnerPreference === 'daemon') {
      try {
        recordStartupMark('daemonOwner.ensure.start');
        await ensureStandaloneOwnerForGui();
        recordStartupMark('daemonOwner.ensure.end');
        daemonGuiOwner = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const fallbackMessage = formatGuiOwnerBootstrapFallbackMessage(message);
        logger.warn(fallbackMessage, { module: 'init' });
        process.stderr.write(`${YELLOW}Warning:${RESET} ${fallbackMessage}\n`);
        daemonGuiOwner = false;
      }
    } else if (guiOwnerPreference === 'auto') {
      recordStartupMark('daemonOwner.discover.start');
      try {
        daemonGuiOwner = await discoverStandaloneOwnerForGui(1_000);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`daemon owner auto-discovery failed; starting GUI owner locally: ${message}`, { module: 'init' });
        daemonGuiOwner = false;
      }
      recordStartupMark('daemonOwner.discover.end', { daemonOwner: daemonGuiOwner });
    }

    if (daemonGuiOwner) {
      ownerMode = false;
      guiUsingDaemonOwner = true;
      try {
        recordStartupMark('initServices.readOnly.start');
        await initServices({ readOnly: true, executionAgentRegistry: agentRegistry, startupSyncMode: 'none' });
        recordStartupMark('initServices.readOnly.end', { ownerMode: false, daemonOwner: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${RED}Error:${RESET} ${message}\n`);
        app.quit();
        return;
      }
    } else {
      ownerMode = true;
      guiUsingDaemonOwner = false;
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
        guiUsingDaemonOwner = false;
        recordStartupMark('initServices.readOnly.end', { ownerMode: false });
      }
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
      launchDispatcher = new LaunchDispatcher({
        persistence,
        orchestrator,
        // taskExecutor is re-built by rebuildTaskRunner(); read via
        // a provider so the dispatcher always picks up the current
        // instance instead of capturing a stale reference.
        taskRunnerProvider: () => taskExecutor,
        ownerId: workflowMutationOwnerId,
        logger,
      });
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
        if (kind === 'workflow-status') {
          return orchestrator.getWorkflowStatus();
        }
        if (kind === 'tasks' || kind === 'task-graph-refresh') {
          if (kind === 'task-graph-refresh') {
            orchestrator.syncAllFromDb();
          }
          return {
            tasks: orchestrator.getAllTasks(),
            workflows: persistence.listWorkflows(),
            streamSequence: getTaskDeltaStreamSequence(),
            invokerHomeRoot: resolveInvokerHomeRoot(),
          };
        }
        if (kind === 'action-graph') {
          return buildCurrentActionGraphSnapshot({ orchestrator, persistence, invokerConfig });
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
        const payload: HeadlessExecMutationPayload = {
          args,
          waitForApproval: delegatedWait,
          noTrack: delegatedNoTrack,
          traceId,
        };
        logHeadlessExecReceived(payload, 'gui');
        const { workflowId, priority } = classifyHeadlessExecMutation(payload);
        const acknowledgement = acknowledgeNoTrackHeadlessExec(payload, workflowId, priority, 'gui');
        if (acknowledgement) return acknowledgement;
        return runWorkflowMutation(workflowId, priority, 'headless.exec', [payload], async () => executeHeadlessExec(payload));
      });
      messageBus.onRequest('headless.batch-exec', async (req: unknown) => {
        const request = req as HeadlessBatchExecRequest;
        const itemCount = Array.isArray(request.items) ? request.items.length : 0;
        logger.info(`headless.batch-exec received items=${itemCount} noTrack=${request.noTrack ? 'true' : 'false'} mode=gui`, {
          module: 'ipc-delegate',
        });
        if (!workflowMutationCoordinator) {
          throw new Error('Workflow mutation coordinator is unavailable');
        }
        const coordinator = workflowMutationCoordinator;
        const results = executeNoTrackHeadlessBatch(request, {
          classify: classifyHeadlessExecMutation,
          submit: (workflowId, priority, channel, args, options) =>
            coordinator.submit(workflowId, priority, channel, args, options),
        });
        const accepted = results.filter((result) => result.ok).length;
        logger.info(`headless.batch-exec accepted=${accepted} failed=${results.length - accepted} mode=gui`, {
          module: 'ipc-delegate',
        });
        return results;
      });
      logger.info(`owner-ipc-ready ownerId=${workflowMutationOwnerId}`, { module: 'ipc-delegate' });
      recordStartupMark('owner-ipc-ready');
    }

    bootstrapInitialWorkflowState();
    if (ownerMode) {
      startLifecycleEventBridge({
        messageBus,
        getInitialTasks: () => orchestrator.getAllTasks(),
        getTask: (taskId) => orchestrator.getTask(taskId),
        logger,
      });
    }

    reviewGateStatusWorker = startReviewGateStatusWorker({
      ownerMode,
      getTaskExecutor: requireTaskExecutor,
      logger,
    });

    // Relaunch orphaned running tasks and start any pending-but-ready tasks.
    if (!ownerMode) {
      logger.info('follower mode startup: auto-run disabled', { module: 'init' });
    } else if (invokerConfig.disableAutoRunOnStartup) {
      logger.info('auto-run on startup disabled by config', { module: 'init' });
    } else {
      orchestrator.startExecution();
    }

    const dbPath = path.join(resolveInvokerHomeRoot(), 'invoker.db');
    logger.info(`IPC socket: ${resolveInvokerIpcSocketPath()}`, { module: 'init' });
    logger.info(`Database: ${dbPath}`, { module: 'init' });
    logger.info(`Repo root: ${repoRoot}`, { module: 'init' });
    logger.info(`Config: disableAutoRunOnStartup=${invokerConfig.disableAutoRunOnStartup ?? false}`, { module: 'init' });
    logger.info('Effective configuration', { config: getSafeInvokerConfigForLogging(invokerConfig), module: 'startup' });
    recordStartupMark('startup.ready-for-window');

    // Forward deltas to renderer and keep snapshot cache in sync so
    // the db-poll doesn't re-emit deltas the messageBus already delivered.
    messageBus.subscribe(Channels.TASK_DELTA, (delta: unknown) => {
      uiPerfStats.mainDeltaToUi += 1;
      const d = delta as TaskDelta;
      if (traceUiDeltaFlow) {
        logger.debug(`delta→ui: ${JSON.stringify(delta)}`, { module: 'ui' });
      }

      const deltaTaskId = d.type === 'updated' || d.type === 'removed'
        ? d.taskId
        : undefined;
      if (d.type === 'updated' && d.changes.status === 'failed') {
        const cancellationError = shouldSkipAutoFixForError(d.changes.execution?.error);
        const shouldAutoFixFromOrchestrator = orchestrator.shouldAutoFix(d.taskId);
        logAutoFixDebug(d.taskId, 'delta-failed', {
          shouldSkipForCancellation: cancellationError,
          shouldAutoFixFromOrchestrator,
        });
        if (!cancellationError && shouldAutoFixFromOrchestrator && deltaTaskId) {
          logAutoFixDebug(deltaTaskId, 'delta-trigger-schedule');
          scheduleAutoFix(deltaTaskId);
        } else if (deltaTaskId) {
          logAutoFixDebug(deltaTaskId, 'delta-skip', {
            reason: cancellationError ? 'cancellation-error' : 'shouldAutoFix-false',
            shouldSkipForCancellation: cancellationError,
            shouldAutoFixFromOrchestrator,
          });
        }
      }

      for (const rendererDelta of applyTaskDeltaToOwnerCacheOrRecover(d)) {
        publishTaskDeltaToRenderer(rendererDelta);
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
    registerBootstrapStateIpc({
      ipcMain,
      getTasks: () => orchestrator.getAllTasks(),
      getWorkflows: () => listWorkflowsByStartupRecency(),
      getInitialWorkflowId: () => startupWorkflowId,
      appStartedAtEpochMs: appProcessStartedAt,
      getTaskDeltaStreamSequence,
      recordStartupDuration,
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
      const injectTaskStates = async (updates: Array<{ taskId: string; changes: TaskStateChanges }>): Promise<void> => {
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
      };
      ipcMain.handle(
        'invoker:inject-task-states',
        async (_event, updates: Array<{ taskId: string; changes: TaskStateChanges }>) => {
          if (!ownerMode) {
            await messageBus.request('headless.gui-mutation', {
              channel: 'invoker:inject-task-states',
              args: [updates],
            } satisfies GuiMutationPayload);
            return;
          }
          await injectTaskStates(updates);
        },
      );
    }

    registerGuiMutationHandler('invoker:start', async () => {
      logger.info('start', { module: 'ipc' });
      const started = orchestrator.startExecution();
      logger.info(`startExecution returned ${started.length} tasks: [${started.map(t => t.id).join(', ')}]`, { module: 'ipc' });
      return started;
    });

    registerGuiMutationHandler('invoker:resume-workflow', async () => {
      const workflows = persistence.listWorkflows();
      if (workflows.length === 0) {
        logger.info('resume-workflow: no workflows found', { module: 'ipc' });
        return null;
      }
      orchestrator.syncAllFromDb();

      const tasksToRecover = orchestrator.getAllTasks().filter(isTaskRecoverableOnExplicitResume);
      for (const task of tasksToRecover) {
        orchestrator.prepareTaskForNewAttempt(task.id, 'resume_workflow_recovery');
      }

      const allStarted = orchestrator.startExecution();
      const tasks = orchestrator.getAllTasks();
      workflowRollupProjection.replaceAll(tasks);
      for (const task of tasks) {
        lastKnownTaskStates.set(task.id, JSON.stringify(task));
        if (mainWindow && !mainWindow.isDestroyed()) {
          publishTaskDeltaToRenderer({ type: 'created', task });
        }
      }
      logger.info(`resume-workflow: ${tasks.length} tasks loaded across ${workflows.length} workflows, ${allStarted.length} started`, { module: 'ipc' });
      if (allStarted.length > 0 && launchDispatcher) {
        try {
          launchDispatcher.poll();
        } catch (err) {
          logger.warn(
            `resume-workflow: launch dispatcher poll failed: ${err instanceof Error ? err.message : String(err)}`,
            { module: 'ipc' },
          );
        }
      }
      return { workflow: workflows[0], taskCount: tasks.length, startedCount: allStarted.length };
    });

    registerGuiMutationHandler('invoker:stop', async () => {
      logger.info('stop — destroying all executors', { module: 'ipc' });
      const failInFlightTasks = (): void => {
        const allTasks = orchestrator.getAllTasks();
        for (const task of allTasks) {
          if (isTaskInFlightForForcedStop(task)) {
            logger.info(`stop — failing in-flight task "${task.id}" (${task.status})`, { module: 'ipc' });
            persistShutdownDiagnostic(task, persistence, {
              flushPendingOutput: flushTaskOutput,
              forcedStopReason: 'Stopped by user',
            });
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
      await sharedDeleteAllWorkflows({ logger, orchestrator, taskExecutor: taskExecutor ?? undefined });
      await Promise.all(executorRegistry.getAll().map(f => f.destroyAll().catch(() => undefined)));

      orchestrator = new Orchestrator({
        persistence,
        messageBus,
        taskRepository: new SqliteTaskRepository(persistence),
        maxConcurrency: effectiveMaxConcurrency,
        defaultAutoFixRetries: invokerConfig.autoFixRetries,
        executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
        defaultPoolId: invokerConfig.defaultPoolId,
        availablePoolIds: Object.keys(invokerConfig.executionPools ?? {}),
        deferRunningUntilLaunch: true,
      });
      commandService = new CommandService(
        orchestrator,
        buildCommandServiceInvalidationDeps(),
      );
      rebuildTaskRunner();
      taskHandles.clear();
      lastKnownTaskStates.clear();
      workflowRollupProjection.clear();
      lastKnownWorkflowCount = 0;
      requestWorkflowMetadataPublish('clear');
    });


    ipcMain.handle('invoker:refresh-task-graph', async () => {
      const startedAtMs = Date.now();
      const snapshot = await resolveRefreshTaskGraphSnapshot({
        ownerMode,
        messageBus,
        resolveInvokerHomeRoot,
        orchestrator,
        persistence,
        logger,
      });

      taskGraphEventPublisher.publishSnapshot(
        ownerMode ? 'refresh-task-graph' : 'refresh-task-graph-delegated',
        snapshot.tasks,
        snapshot.workflows,
      );
      recordStartupDuration('refresh-task-graph.return', startedAtMs, {
        taskCount: snapshot.tasks.length,
        workflowCount: snapshot.workflows.length,
        streamSequence: getTaskDeltaStreamSequence(),
      });
    });
    registerReadOnlyIpcHandlers({
      ipcMain,
      logger,
      persistence,
      getOrchestrator: () => orchestrator,
      agentRegistry,
      loadTaskByIdFromPersistence,
      resolveAgentSession,
      getOwnerMode: () => ownerMode,
      getMessageBus: () => messageBus,
      recordStartupDuration,
      getTaskDeltaStreamSequence,
    });

    registerGuiMutationHandler('invoker:delete-all-workflows', async () => {
      logger.info('delete-all-workflows', { module: 'ipc' });
      assertDeleteAllEnabled();
      await sharedDeleteAllWorkflows({ logger, orchestrator, taskExecutor: taskExecutor ?? undefined });
      taskHandles.clear();
      lastKnownTaskStates.clear();
      workflowRollupProjection.clear();
      lastKnownWorkflowCount = 0;
      requestWorkflowMetadataPublish('delete-all-workflows');
    });

    registerGuiMutationHandler('invoker:delete-all-workflows-bulk', async () => {
      logger.info('delete-all-workflows-bulk', { module: 'ipc' });
      assertDeleteAllEnabled();
      await sharedDeleteAllWorkflowsBulk({ logger, orchestrator, taskExecutor: taskExecutor ?? undefined });
      taskHandles.clear();
      lastKnownTaskStates.clear();
      workflowRollupProjection.clear();
      lastKnownWorkflowCount = 0;
      requestWorkflowMetadataPublish('delete-all-workflows-bulk');
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

          const workflows = persistence.listWorkflows();
          lastKnownWorkflowCount = workflows.length;
          requestWorkflowMetadataPublish('delete-workflow');
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
          await performDetachWorkflow(workflowId, upstreamWorkflowId);
        } catch (err) {
          logger.error(`detach-workflow failed: ${err}`, { module: 'ipc' });
          throw err;
        }
      },
    );

    registerTaskScopedGuiMutationHandler(
      'invoker:provide-input',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
      async (taskIdArg: unknown, inputArg: unknown) => {
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

    registerTaskScopedGuiMutationHandler(
      'invoker:reject',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
      async (taskIdArg: unknown, reasonArg?: unknown) => {
      const taskId = String(taskIdArg);
      const reason = reasonArg === undefined ? undefined : String(reasonArg);
      const envelope = makeEnvelope('reject', 'ui', 'task', { taskId, reason });
      const result = await commandService.reject(envelope);
      if (!result.ok) throw new Error(result.error.message);
    });

    registerTaskScopedGuiMutationHandler(
      'invoker:select-experiment',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
      async (taskIdArg: unknown, experimentIdArg: unknown) => {
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
        } else {
          // Multi-select: needs taskExecutor for branch merge, stays in workflow-actions
          await sharedSelectExperiments(taskId, ids, { orchestrator, taskExecutor: requireTaskExecutor() });
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

    ipcMain.handle('invoker:get-action-graph', async () => {
      if (!ownerMode) {
        try {
          return await messageBus.request('headless.query', { kind: 'action-graph' });
        } catch (err) {
          logger.warn(
            `get-action-graph owner delegation failed; falling back to local read-only snapshot: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { module: 'ipc' },
          );
        }
      }
      return buildCurrentActionGraphSnapshot({ orchestrator, persistence, invokerConfig });
    });

    ipcMain.handle('invoker:report-ui-perf', (_event, metric: string, data?: Record<string, unknown>) => {
      const payload = {
        ts: new Date().toISOString(),
        metric,
        ...(data ?? {}),
      };
      if (
        metric === 'startup_bootstrap_state' ||
        metric === 'startup_snapshot_applied' ||
        metric === 'startup_snapshot_skipped_bootstrap_complete' ||
        metric === 'startup_workflow_graph_visible' ||
        metric === 'ui_delta_stream_gap_detected' ||
        (metric === 'useTasks_snapshot_replace' && data?.workflowCount === 0)
      ) {
        logger.info(`ui metric ${metric} ${JSON.stringify(data ?? {})}`, { module: 'ui-state' });
      }
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
        const recreateWfEnvelope = makeEnvelope('recreate-workflow', 'ui', 'workflow', { workflowId });
        const recreateWfResult = activeMutationContext?.mutationTiming
          ? await activeMutationContext.mutationTiming.span(
            'main.ipc.recreate-workflow.commandService.recreateWorkflow',
            undefined,
            () => commandService.recreateWorkflow(recreateWfEnvelope),
          )
          : await commandService.recreateWorkflow(recreateWfEnvelope);
        if (!recreateWfResult.ok) throw new Error(recreateWfResult.error.message);
        const started = recreateWfResult.data;
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
        const recreateTaskEnvelope = makeEnvelope('recreate-task', 'ui', 'task', { taskId });
        const recreateTaskResult = activeMutationContext?.mutationTiming
          ? await activeMutationContext.mutationTiming.span(
            'main.ipc.recreate-task.commandService.recreateTask',
            { taskId },
            () => commandService.recreateTask(recreateTaskEnvelope),
          )
          : await commandService.recreateTask(recreateTaskEnvelope);
        if (!recreateTaskResult.ok) throw new Error(recreateTaskResult.error.message);
        const started = recreateTaskResult.data;
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
      'invoker:recreate-downstream',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'high',
      async (taskIdArg: unknown) => {
      const taskId = String(taskIdArg);
      logger.info(`recreate-downstream: "${taskId}"`, { module: 'ipc' });
      try {
        if (activeMutationContext?.mutationTiming) {
          await activeMutationContext.mutationTiming.span(
            'main.ipc.recreate-downstream.preemptTaskSubgraph',
            { taskId },
            () => preemptTaskSubgraph(taskId),
          );
        } else {
          await preemptTaskSubgraph(taskId);
        }
        const recreateDownstreamEnvelope = makeEnvelope('recreate-downstream', 'ui', 'task', { taskId });
        const recreateDownstreamResult = activeMutationContext?.mutationTiming
          ? await activeMutationContext.mutationTiming.span(
            'main.ipc.recreate-downstream.commandService.recreateDownstream',
            { taskId },
            () => commandService.recreateDownstream(recreateDownstreamEnvelope),
          )
          : await commandService.recreateDownstream(recreateDownstreamEnvelope);
        if (!recreateDownstreamResult.ok) throw new Error(recreateDownstreamResult.error.message);
        const started = recreateDownstreamResult.data;
        remoteFetchForPool.enabled = false;
        try {
          await dispatchStartedTasksWithGlobalTopup({
            orchestrator,
            taskExecutor: requireTaskExecutor(),
            logger,
            context: 'ipc.recreate-downstream',
            started,
            scopedTaskIds: [taskId],
            mutationTiming: activeMutationContext?.mutationTiming,
          });
        } finally {
          remoteFetchForPool.enabled = true;
        }
      } catch (err) {
        logger.error(`recreate-downstream failed: ${err}`, { module: 'ipc' });
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
      'invoker:rebase-retry',
      (targetArg: unknown) => workflowIdForTargetArg(targetArg),
      'high',
      async (targetArg: unknown) => {
      const target = String(targetArg);
      const workflowId = workflowIdForTargetArg(targetArg);
      if (!workflowId) {
        throw new Error(`Could not resolve workflow for rebase-retry target "${target}"`);
      }
      logger.info(`rebase-retry: "${target}"`, { module: 'ipc' });
      try {
        await preemptWorkflowBeforeMutation(workflowId, {
          preemptWorkflowExecution,
          logger,
          context: 'ipc.rebase-retry',
          mutationTiming: activeMutationContext?.mutationTiming,
        });
        const started = await rebaseRetry(target, {
          logger,
          orchestrator,
          persistence,
          commandService,
          repoRoot,
          taskExecutor: requireTaskExecutor(),
          mutationTiming: activeMutationContext?.mutationTiming,
        });
        await dispatchStartedTasksWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.rebase-retry',
          started,
          scopedWorkflowId: workflowId,
          mutationTiming: activeMutationContext?.mutationTiming,
        });
      } catch (err) {
        logger.error(`rebase-retry failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerWorkflowScopedGuiMutationHandler(
      'invoker:rebase-recreate',
      (targetArg: unknown) => workflowIdForTargetArg(targetArg),
      'high',
      async (targetArg: unknown) => {
      const target = String(targetArg);
      const workflowId = workflowIdForTargetArg(targetArg);
      if (!workflowId) {
        throw new Error(`Could not resolve workflow for rebase-recreate target "${target}"`);
      }
      cancelDeferredWorkflowLaunch(workflowId, 'ipc.rebase-recreate');
      logger.info(`rebase-recreate: "${target}"`, { module: 'ipc' });
      try {
        await preemptWorkflowBeforeMutation(workflowId, {
          preemptWorkflowExecution,
          logger,
          context: 'ipc.rebase-recreate',
          mutationTiming: activeMutationContext?.mutationTiming,
        });
        const started = await rebaseRecreate(target, {
          logger,
          orchestrator,
          persistence,
          commandService,
          repoRoot,
          taskExecutor: requireTaskExecutor(),
          mutationTiming: activeMutationContext?.mutationTiming,
        });
        await dispatchStartedTasksWithGlobalTopup({
          orchestrator,
          taskExecutor: requireTaskExecutor(),
          logger,
          context: 'ipc.rebase-recreate',
          started,
          scopedWorkflowId: workflowId,
          mutationTiming: activeMutationContext?.mutationTiming,
        });
      } catch (err) {
        logger.error(`rebase-recreate failed: ${err}`, { module: 'ipc' });
        throw err;
      }
      },
    );

    registerTaskScopedGuiMutationHandler(
      'invoker:set-merge-branch',
      (workflowIdArg: unknown) => String(workflowIdArg),
      'normal',
      async (workflowIdArg: unknown, baseBranchArg: unknown) => {
      const workflowId = String(workflowIdArg);
      const baseBranch = String(baseBranchArg);
      logger.info(`set-merge-branch: workflow="${workflowId}" → "${baseBranch}"`, { module: 'ipc' });
      try {
        persistence.updateWorkflow(workflowId, { baseBranch });

        const tasks = persistence.loadTasks(workflowId);
        const mergeTask = tasks.find(t => t.config.isMergeNode);
        if (mergeTask) {
          const envelope = makeEnvelope('set-merge-branch', 'ui', 'task', { taskId: mergeTask.id });
          const result = await commandService.retryTask(envelope);
          if (!result.ok) throw new Error(result.error.message);
          const started = result.data;
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

    registerTaskScopedGuiMutationHandler(
      'invoker:set-merge-mode',
      (workflowIdArg: unknown) => String(workflowIdArg),
      'normal',
      async (workflowIdArg: unknown, mergeModeArg: unknown) => {
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
      lastKnownWorkflowCount = workflows.length;
      requestWorkflowMetadataPublish('set-merge-mode');
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
        if (err instanceof StaleLineageError) {
          logger.info(`resolve-conflict discarded stale result for "${taskId}": ${err.message}`, { module: 'ipc' });
          return;
        }
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
        const started = await executeFixWithAgentMutation(taskId, agentName, 'ipc');
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
        if (err instanceof StaleLineageError) {
          logger.info(`fix-with-agent discarded stale result for "${taskId}": ${err.message}`, { module: 'ipc' });
          return;
        }
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

    registerTaskScopedGuiMutationHandler(
      'invoker:edit-task-command',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
      async (taskIdArg: unknown, newCommandArg: unknown) => {
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

    registerTaskScopedGuiMutationHandler(
      'invoker:edit-task-prompt',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
      async (taskIdArg: unknown, newPromptArg: unknown) => {
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

    registerTaskScopedGuiMutationHandler(
      'invoker:edit-task-type',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
      async (taskIdArg: unknown, runnerKindArg: unknown, poolMemberIdArg?: unknown) => {
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

    registerTaskScopedGuiMutationHandler(
      'invoker:edit-task-pool',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
      async (taskIdArg: unknown, poolIdArg: unknown) => {
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

    registerTaskScopedGuiMutationHandler(
      'invoker:edit-task-agent',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
      async (taskIdArg: unknown, agentNameArg: unknown) => {
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

    registerTaskScopedGuiMutationHandler(
      'invoker:set-task-external-gate-policies',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'normal',
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
        cliInstaller: resolveCliInstallerStatus(buildCliInstallerContext()),
      });
    });

    ipcMain.handle('invoker:get-bundled-skills-status', () => {
      return getBundledSkillsStatus();
    });

    ipcMain.handle('invoker:install-bundled-skills', (_event, mode = 'install') => {
      return installPackagedSkills(mode);
    });

    ipcMain.handle('invoker:update-invoker-cli', () => {
      return updateInvokerCli(buildCliInstallerContext());
    });

    registerTaskScopedGuiMutationHandler(
      'invoker:replace-task',
      (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
      'high',
      async (taskIdArg: unknown, replacementTasksArg: unknown) => {
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
    ipcMain.handle('invoker:get-activity-logs', (_event, sinceId?: number, limit?: number) => {
      return persistence.getActivityLogs(sinceId ?? 0, limit ?? 2000);
    });

    // ── Embedded terminal session manager (GUI) ─────────────────
    // GUI `invoker:open-terminal` keeps users inside Invoker by opening
    // (or selecting) an embedded session managed in the main process.
    // Headless `open-terminal` still routes to `openExternalTerminalForTask`
    // in `headless.ts` so existing CLI behaviour is preserved.
    ipcMain.handle('invoker:open-terminal', async (_event, taskId: string) => {
      logger.info(`invoked for task="${taskId}"`, { module: 'open-terminal' });
      const liveHandle = taskHandles.get(taskId);
      const resolved = resolveTaskTerminalSpec({
        taskId,
        persistence,
        executorRegistry,
        executionAgentRegistry: agentRegistry,
        repoRoot,
        logger,
        // If a live executor handle exists we can safely attach instead of
        // refusing — embedded mode is designed for this case.
        allowRunning: Boolean(liveHandle),
        runningTaskReason:
          'Task is still running or being fixed with AI. View output in the terminal panel below.',
      });
      if (!resolved.ok) {
        return { opened: false, reason: resolved.reason };
      }
      try {
        const session = embeddedTerminalManager.openOrReuse({
          taskId,
          spec: resolved.spec,
          cwd: resolved.cwd,
          attach: liveHandle ? { handle: liveHandle.handle, executor: liveHandle.executor } : undefined,
        });
        return { opened: true, session };
      } catch (err) {
        // A backend spawn failure (e.g. node-pty's spawn-helper missing its
        // exec bit) must surface as a visible refusal, not a rejected IPC
        // promise the renderer drops silently.
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn(`terminal session spawn failed for task="${taskId}": ${reason}`, { module: 'open-terminal' });
        return { opened: false, reason: `Failed to start terminal session: ${reason}` };
      }
    });

    ipcMain.handle('invoker:terminal-list', async () => {
      return embeddedTerminalManager.list();
    });

    ipcMain.handle('invoker:terminal-write', async (_event, sessionId: string, data: string) => {
      return embeddedTerminalManager.write(sessionId, data);
    });

    ipcMain.handle('invoker:terminal-resize', async (_event, sessionId: string, cols: number, rows: number) => {
      return embeddedTerminalManager.resize(sessionId, cols, rows);
    });

    ipcMain.handle('invoker:terminal-close', async (_event, sessionId: string) => {
      return embeddedTerminalManager.close(sessionId);
    });

    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildAppMenuTemplate({
          isMac: process.platform === 'darwin',
          onUpdateInvokerCli: updateInvokerCliFromMenu,
        }),
      ),
    );

    seedUiSnapshotCache();
    createWindow();
    recordStartupMark('createWindow.end');

    // Auto-install/update the bundled invoker-cli onto the user's PATH.
    // Deferred past first paint; the version probe spawnSync still blocks
    // briefly, so it must never run before the window is up.
    setTimeout(() => {
      try {
        maybeAutoInstallCli(buildCliInstallerContext(), (message) =>
          logger.info(message, { module: 'cli-installer' }),
        );
      } catch (err) {
        logger.warn(`invoker-cli auto-install failed: ${err}`, { module: 'cli-installer' });
      }
    }, 0);

    registerMainWindowActivateHandler({
      app,
      createWindow,
    });
  };

  runElectronReadyBootstrap({
    app,
    run: runGuiReadyBootstrap,
    onError: (err) => {
      process.stderr.write(`${RED}Error:${RESET} ${err instanceof Error ? err.message : String(err)}\n`);
      app.quit();
    },
  });

  let isQuitting = false;
  registerGuiLifecycleHandlers(app, {
    onWindowAllClosed: () => {
      logger.info('window-all-closed', { module: 'window' });
      if (process.platform !== 'darwin') {
        app.quit();
      }
    },
    onBeforeQuit: async (event) => {
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
        if (webBridge) await webBridge.close().catch(() => {});
        reviewGateStatusWorker?.stop();
        reviewGateStatusWorker = null;
        if (dbPollInterval) clearInterval(dbPollInterval);
        if (activityPollInterval) clearInterval(activityPollInterval);
        if (uiPerfLogInterval) clearInterval(uiPerfLogInterval);
        if (hourlyBackupInterval) {
          clearInterval(hourlyBackupInterval);
          hourlyBackupInterval = null;
        }
        embeddedTerminalManager.closeAll();
        if (executorRegistry) {
          await Promise.all(executorRegistry.getAll().map(f => f.destroyAll()));
        }
        if (orchestrator) {
          for (const task of orchestrator.getAllTasks()) {
            if (task.status === 'running' || task.status === 'fixing_with_ai') {
              if (persistence) {
                persistShutdownDiagnostic(task, persistence, {
                  flushPendingOutput: flushTaskOutput,
                  forcedStopReason: 'Application quit',
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
        if (persistence) {
          persistence.requeueRunningWorkflowMutationIntents();
          persistence.close();
        }
        guiInstanceLock?.release();
        guiInstanceLock = null;
        if (writerLock) writerLock.release();
        if (messageBus) messageBus.disconnect();
      } finally {
        clearTimeout(safetyTimer);
        logger.info('before-quit end -> app.exit(0)', { module: 'process' });
        app.exit(0);
      }
    },
  });

  // ── Slack Bot (embedded in GUI process) ──────────────────
  async function startSlackBot(
    executor: TaskRunner,
    handles: TaskHandleMap,
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
