import type { App, BrowserWindow, IpcMain } from 'electron';
import { Orchestrator, CommandService, OrchestratorErrorCode } from '@invoker/workflow-core';
import type { TaskDelta, TaskReplacementDef, TaskState, TaskStateChanges } from '@invoker/workflow-core';
import { CommandError, IpcChannels, makeEnvelope } from '@invoker/contracts';
import type {
  BundledSkillsInstallMode,
  InAppPlanRequest,
  InAppPlanningChatRequest,
  InAppPlanningCreateSessionRequest,
  InAppPlanningResetRequest,
  InAppPlanningSetTerminalModeRequest,
  InAppPlanningStreamEvent,
  InAppPlanningSubmitRequest,
  Logger,
  StartReadyRequest,
  StartReadyResult,
  WorkflowMutationAcceptedResult,
} from '@invoker/contracts';
import { ConversationRepository, SqliteTaskRepository } from '@invoker/data-store';
import type { SQLiteAdapter, WorkerActionWrite } from '@invoker/data-store';
import { Channels } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import {
  DEFAULT_EXECUTION_AGENT,
  ExecutorRegistry,
  RESTART_TO_BRANCH_TRACE,
  remoteFetchForPool,
  registerBuiltinAgents,
} from '@invoker/execution-engine';
import type { AgentRegistry, WorkerRegistry, WorkerRuntimeDependencies } from '@invoker/execution-engine';
import {
  DEFAULT_SLACK_HARNESS_PRESETS,
  loadConfig,
  resolveDefaultTaskExecutionSettings,
  type InvokerConfig,
} from '../config.js';
import { resolveAutoApproveAIFixes, resolveAutoFixRetries } from '../autofix-defaults.js';
import { backupPlan } from '../plan-backup.js';
import { runHeadless, resolveAgentSession } from '../headless.js';
import type { HeadlessDeps } from '../headless.js';
import { resolveRefreshTaskGraphSnapshot } from '../refresh-task-graph.js';
import { resolveHeadlessTarget, resolveHeadlessTargetWorkflowId } from '../headless-command-classification.js';
import {
  fixWithAgentAction,
  rebaseRecreate,
  rebaseRetry,
  resolveConflictAction,
  selectFailureRecoveryRoute,
  selectExperiments as sharedSelectExperiments,
  approveTask as sharedApproveTask,
  deleteAllWorkflows as sharedDeleteAllWorkflows,
  deleteAllWorkflowsBulk as sharedDeleteAllWorkflowsBulk,
  setWorkflowMergeMode,
  StaleLineageError,
} from '../workflow-actions.js';
import {
  dispatchStartedTasksWithGlobalTopup,
  finalizeMutationWithGlobalTopup,
  isDispatchableLaunch,
} from '../global-topup.js';
import { preemptWorkflowBeforeMutation, type WorkflowCancelResult } from '../workflow-preemption.js';
import type { WorkflowMutationPriority } from '../workflow-mutation-coordinator.js';
import { submitWorkflowMutationOrAcknowledgeDeleted } from '../workflow-mutation-submit.js';
import type { WorkflowMutationContext } from '../persisted-workflow-mutation-coordinator.js';
import {
  buildHeadlessFixArgs,
  listOpenFixIntentsForTask,
  parseFixWithAgentMutationArgs,
  type ReviewGateCiContext,
} from '../auto-fix-intents.js';
import { persistShutdownDiagnostic } from '../shutdown-diagnostic.js';
import { buildCurrentActionGraphSnapshot } from '../action-graph-snapshot.js';
import { registerReadOnlyIpcHandlers } from '../ipc-read-handlers.js';
import {
  createInAppPlanningChatSessions,
  createPlanningChatSession,
  createPlanningCommandBuilderFromRegistry,
  listInAppPlanningPresets,
  listPlanningChatSessions,
  planFromGoal as planFromGoalInApp,
  resetPlanningChat,
  restorePlanningChatSessions,
  sendPlanningChatMessage,
  setPlanningChatTerminalMode,
  submitPlanningChatDraft,
} from '../in-app-planner.js';
import { seedMainProcessHitchFixture } from '../main-process-hitch-fixture.js';
import { seedStressFixture, type StressFixtureOptions } from '../stress-fixture.js';
import { buildReviewGateQueryResponse } from '../review-gate-query.js';
import { recordRendererUiPerfMetric, type RendererUiPerfCounters } from '../renderer-ui-perf.js';
import {
  AUTO_STARTED_OWNER_WORKER_KINDS,
  createLocalWorkerStatusSnapshot,
} from '../worker-control.js';
import { runStartReady } from '../start-ready.js';
import type { WorkerRuntimeController } from '../worker-control.js';
import { buildTaskGraphSnapshot } from '../web/task-graph-snapshot.js';
import { collectSystemDiagnostics } from '../system-diagnostics.js';
import { resolveConfigFileState } from '../config.js';
import { installBundledSkills, resolveBundledSkillsStatus } from '../bundled-skills.js';
import { resolveCliInstallerStatus, updateInvokerCli, type CliInstallerContext } from '../cli-installer.js';
import { runInvokerCliSetup } from '../invoker-cli-setup.js';
import { resolveBundledCliPath } from '../cli-helper.js';
import { isMutationOwnerUnavailableError } from '../bootstrap/app-bootstrap.js';
import type { HeadlessExecMutationPayload } from '../headless-batch-exec.js';
import type { TaskHandleMap } from '../execution/task-runner-wiring.js';
import type { TaskRunner } from '@invoker/execution-engine';
import { createRendererTaskFeed } from '../window/renderer-task-feed.js';
import { createTaskGraphEventPublisher } from '../task-graph-event-publisher.js';
import type { GuiMutationPayload, GuiMutationRegistrars } from './ipc-registration.js';
import { resolveInvokerHomeRoot } from '../delete-all-snapshot.js';
import {
  buildRecoveryWorkerAuditPayload,
  classifyAutoFixRecoveryPhase,
  recoveryWorkerEventType,
} from '../recovery-worker-observability.js';

interface HeadlessRunMutationPayload {
  planPath: string;
  traceId?: string;
}

interface HeadlessResumeMutationPayload {
  workflowId: string;
  traceId?: string;
}

type RendererTaskFeed = ReturnType<typeof createRendererTaskFeed>;
type TaskGraphEventPublisher = ReturnType<typeof createTaskGraphEventPublisher>;

export interface GuiMutationTaskActions {
  scheduleAutoFix: (taskId: string) => void;
  logAutoFixDebug: (taskId: string, phase: string, details?: Record<string, unknown>) => void;
  performDeleteWorkflow: (workflowId: string) => Promise<void>;
  performDetachWorkflow: (workflowId: string, upstreamWorkflowId: string) => Promise<void>;
  performCancelTask: (taskId: string) => Promise<{ cancelled: string[]; runningCancelled: string[] }>;
  performDeleteTask: (taskId: string) => Promise<void>;
  performCancelWorkflow: (workflowId: string) => Promise<{ cancelled: string[]; runningCancelled: string[] }>;
  preemptTaskSubgraph: (taskId: string) => Promise<void>;
  preemptWorkflowExecution: (workflowId: string) => Promise<WorkflowCancelResult>;
  performSharedApproveTask: (
    taskId: string,
    source: 'ui' | 'surface' | 'api',
    scope?: 'task' | 'workflow',
  ) => Promise<{ started: TaskState[] }>;
  executeFixWithAgentMutation: (
    taskId: string,
    agentName?: string,
    source?: 'ipc' | 'auto-fix',
    reviewGateContext?: ReviewGateCiContext,
  ) => Promise<TaskState[]>;
  executeHeadlessRun: (payload: HeadlessRunMutationPayload) => Promise<{ workflowId: string; tasks: TaskState[] }>;
  executeHeadlessResume: (payload: HeadlessResumeMutationPayload) => Promise<{ workflowId: string; tasks: TaskState[] }>;
  executeHeadlessExec: (payload: HeadlessExecMutationPayload) => Promise<unknown>;
  classifyHeadlessExecMutation: (payload: HeadlessExecMutationPayload) => { workflowId?: string; priority: WorkflowMutationPriority };
  translateGuiMutationToHeadless: (payload: GuiMutationPayload) =>
    | { channel: 'headless.gui-mutation'; request: GuiMutationPayload }
    | { channel: 'headless.run'; request: HeadlessRunMutationPayload }
    | { channel: 'headless.resume'; request: HeadlessResumeMutationPayload }
    | { channel: 'headless.exec'; request: HeadlessExecMutationPayload }
    | null;
  runWorkflowMutation: <T>(
    workflowId: string | undefined,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
    op: () => Promise<T>,
  ) => Promise<T>;
  submitWorkflowMutation: (
    workflowId: string | undefined,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
  ) => WorkflowMutationAcceptedResult;
  workflowIdForTargetArg: (targetArg: unknown) => string | undefined;
  workflowIdForTaskArg: (taskIdArg: unknown) => string | undefined;
  refreshRuntime: () => void;
}

export interface GuiMutationTaskActionsContext {
  logger: Logger;
  persistence: SQLiteAdapter;
  messageBus: MessageBus;
  executorRegistry: ExecutorRegistry;
  agentRegistry: AgentRegistry;
  repoRoot: string;
  invokerConfig: InvokerConfig;
  effectiveMaxConcurrency: number;
  taskHandles: TaskHandleMap;
  getOrchestrator: () => Orchestrator;
  setOrchestrator: (orchestrator: Orchestrator) => void;
  getCommandService: () => CommandService;
  setCommandService: (commandService: CommandService) => void;
  getWorkflowMutationCoordinator: () => { enqueue: <T>(workflowId: string, priority: WorkflowMutationPriority, channel: string, args: unknown[]) => Promise<T>; submit: (workflowId: string, priority: WorkflowMutationPriority, channel: string, args: unknown[], options?: { deferDrain?: boolean }) => number } | null;
  workflowMutationDispatcher: Map<string, (...args: unknown[]) => Promise<unknown>>;
  getActiveMutationContext: () => WorkflowMutationContext | undefined;
  getRendererTaskFeed: () => RendererTaskFeed;
  getStartupWorkflowId: () => string | null;
  getLaunchDispatcher: () => { poll: () => void } | null;
  requireTaskExecutor: () => TaskRunner;
  getTaskExecutor: () => TaskRunner | null;
  rebuildTaskRunner: () => void;
  initServices: (options?: { detachedViewer?: boolean; executionAgentRegistry?: AgentRegistry; startupSyncMode?: 'all' | 'none' }) => Promise<void>;
  requestWorkflowMetadataPublish: (reason: string) => void;
  cancelDeferredWorkflowLaunch: (workflowId: string, reason: string) => void;
  killRunningTask: (taskId: string) => Promise<void>;
  buildCommandServiceInvalidationDeps: () => ConstructorParameters<typeof CommandService>[1];
}

export interface RegisterGuiMutationIpcHandlersContext extends GuiMutationTaskActionsContext {
  ipcMain: IpcMain;
  app: App;
  getMainWindow: () => BrowserWindow | null;
  getOwnerMode: () => boolean;
  getWorkerRuntimeController: () => WorkerRuntimeController | null;
  registrars: GuiMutationRegistrars;
  actions: GuiMutationTaskActions;
  planningChatSessions: ReturnType<typeof createInAppPlanningChatSessions>;
  planningCommandBuilder: ReturnType<typeof createPlanningCommandBuilderFromRegistry>;
  emitPlanningChatStream: (event: InAppPlanningStreamEvent) => void;
  taskGraphEventPublisher: TaskGraphEventPublisher;
  loadTaskByIdFromPersistence: (taskId: string) => TaskState | undefined;
  markDaemonOwnerUnavailable: (reason: string) => void;
  recordStartupDuration: (label: string, startedAtMs: number, fields?: Record<string, unknown>) => void;
  getTaskDeltaStreamSequence: () => number;
  computeRuntimeStatus: () => unknown;
  getUiPerfStats: () => Record<string, unknown>;
  uiPerfStats: RendererUiPerfCounters;
  createRegisteredWorkerRegistry: () => WorkerRegistry<WorkerRuntimeDependencies>;
  buildCliInstallerContext: () => CliInstallerContext;
  resolveSetupCliPath: () => string;
  getBundledSkillsStatus: () => ReturnType<typeof resolveBundledSkillsStatus>;
  installPackagedSkills: (mode?: BundledSkillsInstallMode) => ReturnType<typeof installBundledSkills>;
}

function assertDeleteAllEnabled(): void {
  if (process.env.INVOKER_ALLOW_DELETE_ALL === '1') return;
  throw new Error(
    'delete-all is disabled by default. Set INVOKER_ALLOW_DELETE_ALL=1 to enable it explicitly.',
  );
}

function isTaskInFlightForForcedStop(task: TaskState): boolean {
  return task.status === 'running'
    || task.status === 'fixing_with_ai'
    || (task.status === 'pending' && task.execution.phase === 'launching');
}

export function createGuiMutationTaskActions(context: GuiMutationTaskActionsContext): GuiMutationTaskActions {
  const {
    logger,
    persistence,
    messageBus,
    executorRegistry,
    agentRegistry,
    repoRoot,
    invokerConfig,
    effectiveMaxConcurrency,
    taskHandles,
    workflowMutationDispatcher,
    requireTaskExecutor,
    getTaskExecutor,
    rebuildTaskRunner,
    initServices,
    requestWorkflowMetadataPublish,
    cancelDeferredWorkflowLaunch,
    killRunningTask,
    buildCommandServiceInvalidationDeps,
  } = context;
  let orchestrator = context.getOrchestrator();
  let commandService = context.getCommandService();
  const activeMutationContext = {
    get signal() { return context.getActiveMutationContext()?.signal; },
    get mutationTiming() { return context.getActiveMutationContext()?.mutationTiming; },
  };
  const rendererTaskFeed = context.getRendererTaskFeed();
  const getWorkflowMutationCoordinator = () => context.getWorkflowMutationCoordinator();
  const refreshRuntime = (): void => {
    orchestrator = context.getOrchestrator();
    commandService = context.getCommandService();
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
    reviewGateContext?: ReviewGateCiContext,
  ): Promise<TaskState[]> => {
    const task = orchestrator.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    const savedError = task.execution.error ?? '';
    const recoveryRoute = selectFailureRecoveryRoute(task, savedError);
    logger.info(
      `fix-with-agent: "${taskId}" agent=${agentName ?? DEFAULT_EXECUTION_AGENT} source=${source} route=${recoveryRoute.kind}`,
      { module: 'ipc' },
    );

    const result = await fixWithAgentAction(
      taskId,
      {
        logger,
        orchestrator,
        persistence,
        commandService,
        taskExecutor: requireTaskExecutor(),
        mutationTiming: activeMutationContext?.mutationTiming,
        autoApproveAIFixes: resolveAutoApproveAIFixes(invokerConfig),
      },
      {
        agentName,
        recoveryRoute,
        recreateOutputLabel: source === 'auto-fix' ? 'Auto-fix' : 'Fix with AI',
        failureOutputLabel: source === 'auto-fix' ? 'Auto-fix' : `Fix with ${agentName ?? 'Codex'}`,
        reviewGateContext,
        signal: activeMutationContext?.signal,
      },
    );
    return result.started;
  };

  const scheduleAutoFix = (taskId: string): void => {
    logAutoFixDebug(taskId, 'schedule-enter');
    const workflowMutationCoordinator = getWorkflowMutationCoordinator();
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

  async function performDeleteTask(taskId: string): Promise<void> {
    logger.info(`performDeleteTask begin task="${taskId}"`, { module: 'kill' });
    const task = orchestrator.getTask(taskId);
    const workflowId = task?.config.workflowId;
    if (task && (task.status === 'running' || task.status === 'fixing_with_ai')) {
      await killRunningTask(task.id);
    }
    if (workflowId) {
      await requireTaskExecutor().closeWorkflowReview(workflowId);
    }
    const envelope = makeEnvelope('delete-task', 'ui', 'task', { taskId });
    const result = await commandService.deleteTask(envelope);
    if (!result.ok) throw CommandError.fromResult(result.error);
    remoteFetchForPool.enabled = false;
    try {
      await dispatchStartedTasksWithGlobalTopup({
        orchestrator,
        taskExecutor: requireTaskExecutor(),
        logger,
        context: 'ipc.delete-task',
        started: result.data,
        scopedTaskIds: result.data.map((startedTask) => startedTask.id),
        mutationTiming: activeMutationContext?.mutationTiming,
      });
    } finally {
      remoteFetchForPool.enabled = true;
    }
    requestWorkflowMetadataPublish('delete-task');
    logger.info(`performDeleteTask end task="${taskId}"`, { module: 'kill' });
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
    requestWorkflowMetadataPublish('delete-workflow');
    logger.info(`performDeleteWorkflow end workflow="${workflowId}"`, { module: 'kill' });
  }

  async function performDetachWorkflow(workflowId: string, upstreamWorkflowId: string): Promise<void> {
    logger.info(`performDetachWorkflow begin workflow="${workflowId}" upstream="${upstreamWorkflowId}"`, { module: 'kill' });
    const envelope = makeEnvelope('detach-workflow', 'ui', 'workflow', { workflowId, upstreamWorkflowId });
    const result = await commandService.detachWorkflow(envelope);
    if (!result.ok) throw new Error(result.error.message);
    logger.info(`performDetachWorkflow end workflow="${workflowId}" upstream="${upstreamWorkflowId}"`, { module: 'kill' });
    requestWorkflowMetadataPublish('detach-workflow');
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

  async function executeHeadlessRun(payload: HeadlessRunMutationPayload): Promise<{ workflowId: string; tasks: TaskState[] }> {
    const { applyConfiguredPlanDefaults, parsePlanFile } = await import('../plan-parser.js');
    const plan = applyConfiguredPlanDefaults(await parsePlanFile(payload.planPath));
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
      repoRoot, invokerConfig, initServices,
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
      case 'detach-workflow':
        return { workflowId: arg0, priority: 'high' };
      case 'rebase-retry':
      case 'rebase-recreate':
        return { workflowId: workflowIdForTargetArg(arg0), priority: 'high' };
      case 'cancel':
      case 'retry-task':
      case 'recreate-task':
      case 'delete-task':
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
    const workflowMutationCoordinator = getWorkflowMutationCoordinator();
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
    const workflowMutationCoordinator = getWorkflowMutationCoordinator();
    if (!workflowMutationCoordinator) throw new Error('Workflow mutation coordinator is unavailable');
    if (!workflowMutationDispatcher.has(channel)) {
      throw new Error(`No workflow mutation dispatcher registered for ${channel}`);
    }
    return submitWorkflowMutationOrAcknowledgeDeleted(workflowId, priority, channel, args, {
      coordinator: workflowMutationCoordinator,
      workflowExists: (id) => Boolean(persistence.loadWorkflow(id)),
      logger,
    });
  }

  function translateGuiMutationToHeadless(payload: GuiMutationPayload):
    | { channel: 'headless.gui-mutation'; request: GuiMutationPayload }
    | { channel: 'headless.run'; request: HeadlessRunMutationPayload }
    | { channel: 'headless.resume'; request: HeadlessResumeMutationPayload }
    | { channel: 'headless.exec'; request: HeadlessExecMutationPayload }
    | null {
    const [arg0, arg1, arg2] = payload.args;
    switch (payload.channel) {
      case 'invoker:planning-chat-create':
      case 'invoker:planning-chat-list':
      case 'invoker:plan-from-goal':
      case 'invoker:planning-chat-send':
      case 'invoker:planning-chat-submit':
      case 'invoker:planning-chat-reset':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:load-plan':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:start':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:start-ready':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:stop':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:clear':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:start-worker':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:stop-worker':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:set-workers-enabled':
        return { channel: 'headless.gui-mutation', request: payload };
      case 'invoker:resume-workflow': {
        const workflows = rendererTaskFeed.getDetachedViewerWorkflows() ?? persistence.listWorkflows();
        const firstWorkflow = workflows[0] as { id?: unknown } | undefined;
        const workflowId = context.getStartupWorkflowId()
          ?? (typeof firstWorkflow?.id === 'string' ? firstWorkflow.id : undefined);
        if (!workflowId) return null;
        return { channel: 'headless.resume', request: { workflowId } };
      }
      case 'invoker:delete-all-workflows':
        return { channel: 'headless.exec', request: { args: ['delete-all'] } };
      case 'invoker:delete-all-workflows-bulk':
        return { channel: 'headless.exec', request: { args: ['delete-all'] } };
      case 'invoker:delete-task':
        return { channel: 'headless.exec', request: { args: ['delete-task', String(arg0)], noTrack: true } };
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
      case 'invoker:edit-task-model':
        return { channel: 'headless.exec', request: { args: ['set', 'model', String(arg0), arg1 == null ? '' : String(arg1)], noTrack: true } };
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


  return {
    scheduleAutoFix,
    logAutoFixDebug,
    performDeleteWorkflow,
    performDetachWorkflow,
    performCancelTask,
    performDeleteTask,
    performCancelWorkflow,
    preemptTaskSubgraph,
    preemptWorkflowExecution,
    performSharedApproveTask,
    executeFixWithAgentMutation,
    executeHeadlessRun,
    executeHeadlessResume,
    executeHeadlessExec,
    classifyHeadlessExecMutation,
    translateGuiMutationToHeadless,
    runWorkflowMutation,
    submitWorkflowMutation,
    workflowIdForTargetArg,
    workflowIdForTaskArg,
    refreshRuntime,
  };
}

export async function registerGuiMutationIpcHandlers(context: RegisterGuiMutationIpcHandlersContext): Promise<void> {
  const {
    ipcMain,
    app,
    logger,
    persistence,
    messageBus,
    executorRegistry,
    agentRegistry,
    repoRoot,
    invokerConfig,
    effectiveMaxConcurrency,
    taskHandles,
    getOwnerMode,
    getWorkerRuntimeController,
    requireTaskExecutor,
    getTaskExecutor,
    rebuildTaskRunner,
    requestWorkflowMetadataPublish,
    cancelDeferredWorkflowLaunch,
    buildCommandServiceInvalidationDeps,
    registrars,
    actions,
    planningChatSessions,
    planningCommandBuilder,
    emitPlanningChatStream,
    taskGraphEventPublisher,
    loadTaskByIdFromPersistence,
    markDaemonOwnerUnavailable,
    recordStartupDuration,
    getTaskDeltaStreamSequence,
    computeRuntimeStatus,
    getUiPerfStats,
    uiPerfStats,
    createRegisteredWorkerRegistry,
    buildCliInstallerContext,
    resolveSetupCliPath,
    getBundledSkillsStatus,
    installPackagedSkills,
  } = context;
  const { registerGuiMutationHandler, registerWorkflowScopedGuiMutationHandler } = registrars;
  const { workflowMutationDispatcher } = context;
  const submitWorkflowMutation = actions.submitWorkflowMutation;
  let orchestrator = context.getOrchestrator();
  let commandService = context.getCommandService();
  const rendererTaskFeed = context.getRendererTaskFeed();
  const activeMutationContext = {
    get signal() { return context.getActiveMutationContext()?.signal; },
    get mutationTiming() { return context.getActiveMutationContext()?.mutationTiming; },
  };
  const mainWindowAvailable = (): boolean => {
    const mainWindow = context.getMainWindow();
    return Boolean(mainWindow && !mainWindow.isDestroyed());
  };
  const ownerMode = getOwnerMode();
  const workerRuntimeController = getWorkerRuntimeController();
  const workflowIdForTaskArg = actions.workflowIdForTaskArg;
  const workflowIdForTargetArg = actions.workflowIdForTargetArg;
  const performDeleteTask = actions.performDeleteTask;
  const performCancelTask = actions.performCancelTask;
  const performCancelWorkflow = actions.performCancelWorkflow;
  const preemptTaskSubgraph = actions.preemptTaskSubgraph;
  const preemptWorkflowExecution = actions.preemptWorkflowExecution;
  const performDeleteWorkflow = actions.performDeleteWorkflow;
  const performDetachWorkflow = actions.performDetachWorkflow;
  const performSharedApproveTask = actions.performSharedApproveTask;
  const executeFixWithAgentMutation = actions.executeFixWithAgentMutation;

  function publishOrchestratorSnapshotToRenderer(): void {
    const workflows = persistence.listWorkflows();
    const tasks = orchestrator.getAllTasks();
    const previousTaskIds = new Set(rendererTaskFeed.listKnownTaskIds());
    rendererTaskFeed.clearTaskSnapshots();
    rendererTaskFeed.replaceWorkflowRollups(tasks);
    for (const task of tasks) {
      previousTaskIds.delete(task.id);
      rendererTaskFeed.rememberTaskState(task);
      if (mainWindowAvailable()) {
        rendererTaskFeed.publishTaskDeltaToRenderer({ type: 'created', task });
      }
    }
    rendererTaskFeed.setLastKnownWorkflowCount(workflows.length);
    if (mainWindowAvailable()) {
      for (const removedTaskId of previousTaskIds) {
        rendererTaskFeed.publishTaskDeltaToRenderer({ type: 'removed', taskId: removedTaskId, previousTaskStateVersion: 0 });
      }
      requestWorkflowMetadataPublish('orchestrator-snapshot');
    }
  }

  function executeStartReady(request: StartReadyRequest = {}): StartReadyResult {
    const result = runStartReady(orchestrator, request);
    if (!result.dryRun) {
      publishOrchestratorSnapshotToRenderer();
    }
    logger.info(
      `start-ready: ready=${result.preview.readyTaskIds.length} recoverable=${result.preview.recoverableTaskIds.length} failedWorkflows=${result.preview.failedWorkflowIds.length} recreated=${result.recreatedWorkflowIds.length} started=${result.started.length} dryRun=${result.dryRun ? 'true' : 'false'}`,
      { module: 'ipc' },
    );
    const launchDispatcher = context.getLaunchDispatcher();
    if (!result.dryRun && result.started.length > 0 && launchDispatcher) {
      try {
        launchDispatcher.poll();
      } catch (err) {
        logger.warn(
          `start-ready: launch dispatcher poll failed: ${err instanceof Error ? err.message : String(err)}`,
          { module: 'ipc' },
        );
      }
    }
    return result;
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

  async function loadGeneratedPlanPreview(
    planText: string,
    options?: { preserveTaskHandles?: boolean; logLabel?: string },
  ): Promise<{ planName: string; workflowId: string; workflowIds?: string[]; workflowCount?: number }> {
    const { applyConfiguredPlanDefaults, parsePlanSubmissionBundle } = await import('../plan-parser.js');
    const submission = parsePlanSubmissionBundle(planText);
    const existingWorkflowIds = new Set(persistence.listWorkflows().map((workflow) => workflow.id));
    const loadedWorkflowIds: string[] = [];
    let upstream: { workflowId: string; featureBranch: string } | undefined;
    logger.info(
      `${options?.logLabel ?? 'plan-from-goal'}: loading "${submission.name}" (${submission.plans.length} workflow${submission.plans.length === 1 ? '' : 's'})`,
      { module: 'ipc' },
    );
    if (!options?.preserveTaskHandles) {
      taskHandles.clear();
    }

    for (const parsedPlan of submission.plans) {
      let plan = applyConfiguredPlanDefaults(parsedPlan);
      if (upstream) {
        plan = {
          ...plan,
          baseBranch: upstream.featureBranch,
          externalDependencies: [
            ...(plan.externalDependencies ?? []),
            {
              workflowId: upstream.workflowId,
              taskId: '__merge__',
              requiredStatus: 'completed',
              gatePolicy: 'review_ready',
            } as const,
          ],
        };
      }
      backupPlan(plan, undefined, logger);
      orchestrator.loadPlan(plan, { allowGraphMutation: invokerConfig.allowGraphMutation });
      const workflow = persistence.listWorkflows().find((candidate) => !existingWorkflowIds.has(candidate.id));
      if (!workflow) {
        throw new Error('Loaded plan did not create a workflow.');
      }
      existingWorkflowIds.add(workflow.id);
      loadedWorkflowIds.push(workflow.id);
      upstream = { workflowId: workflow.id, featureBranch: workflow.featureBranch ?? plan.featureBranch ?? plan.baseBranch ?? 'main' };
    }

    const workflowId = loadedWorkflowIds[loadedWorkflowIds.length - 1];
    if (!workflowId) {
      throw new Error('Loaded plan did not create a workflow.');
    }
    return {
      planName: submission.name,
      workflowId,
      workflowIds: loadedWorkflowIds,
      workflowCount: loadedWorkflowIds.length,
    };
  }

  const planningConversationRepo = new ConversationRepository(persistence, {
    info: (message) => logger.info(message, { module: 'planning-chat' }),
    warn: (message) => logger.warn(message, { module: 'planning-chat' }),
    error: (message) => logger.error(message, { module: 'planning-chat' }),
  });
  await restorePlanningChatSessions(persistence.listInAppPlanningSessions(), {
    config: invokerConfig,
    workingDir: repoRoot,
    sessions: planningChatSessions,
    planningCommandBuilder,
    loadGeneratedPlan: loadGeneratedPlanPreview,
    conversationRepo: planningConversationRepo,
    planningSessionStore: ownerMode ? persistence : undefined,
    onRawPlannerOutput: emitPlanningChatStream,
  });
  let testPlanFromGoalResponse: { planYaml: string; planName: string } | null = null;
  // Two variants: (1) a successful override that returns a canned reply +
  // plan YAML, or (2) an error injection that makes the wrapper throw the
  // given message. The error variant lets visual-proof specs render the
  // exhausted-retry error path without spawning a real planner subprocess.
  let testPlanningChatResponse:
    | { planYaml: string; planName: string; reply?: string }
    | { throwError: string }
    | null = null;


  registerGuiMutationHandler('invoker:plan-from-goal', async (...args: unknown[]) => {
    if (process.env.NODE_ENV === 'test' && testPlanFromGoalResponse) {
      const loaded = await loadGeneratedPlanPreview(testPlanFromGoalResponse.planYaml);
      return { ok: true, planName: testPlanFromGoalResponse.planName, workflowId: loaded.workflowId, workflowIds: loaded.workflowIds, workflowCount: loaded.workflowCount };
    }
    return planFromGoalInApp(args[0] as InAppPlanRequest, {
      config: invokerConfig,
      workingDir: repoRoot,
      loadGeneratedPlan: loadGeneratedPlanPreview,
      planningCommandBuilder,
      conversationRepo: planningConversationRepo,
    });
  });
  registerGuiMutationHandler('invoker:planning-chat-create', async (request: unknown) => {
    return createPlanningChatSession(request as InAppPlanningCreateSessionRequest | undefined, {
      config: invokerConfig,
      workingDir: repoRoot,
      sessions: planningChatSessions,
      planningCommandBuilder,
      loadGeneratedPlan: loadGeneratedPlanPreview,
      conversationRepo: planningConversationRepo,
      planningSessionStore: ownerMode ? persistence : undefined,
      onRawPlannerOutput: emitPlanningChatStream,
    });
  });
  registerGuiMutationHandler('invoker:planning-chat-list', async () => {
    return listPlanningChatSessions({ sessions: planningChatSessions });
  });
  registerGuiMutationHandler('invoker:planning-chat-send', async (request: unknown) => {
    const planningChatResponseOverride = process.env.NODE_ENV === 'test' ? testPlanningChatResponse : null;
    const plannerReplyOverride = planningChatResponseOverride
      ? async (): Promise<string> => {
        if ('throwError' in planningChatResponseOverride) {
          throw new Error(planningChatResponseOverride.throwError);
        }
        return `${planningChatResponseOverride.reply ?? 'Draft plan ready.'}\n\n\`\`\`yaml\n${planningChatResponseOverride.planYaml}\n\`\`\``;
      }
      : undefined;
    return sendPlanningChatMessage(request as InAppPlanningChatRequest, {
      config: invokerConfig,
      workingDir: repoRoot,
      sessions: planningChatSessions,
      planningCommandBuilder,
      loadGeneratedPlan: loadGeneratedPlanPreview,
      conversationRepo: planningConversationRepo,
      planningSessionStore: ownerMode ? persistence : undefined,
      plannerReplyOverride,
      onRawPlannerOutput: emitPlanningChatStream,
    });
  });
  registerGuiMutationHandler('invoker:planning-chat-submit', async (request: unknown) => {
    return submitPlanningChatDraft(request as InAppPlanningSubmitRequest, {
      sessions: planningChatSessions,
      loadGeneratedPlan: (planText) => loadGeneratedPlanPreview(planText, {
        preserveTaskHandles: true,
        logLabel: 'planning-chat-submit',
      }),
      planningSessionStore: ownerMode ? persistence : undefined,
    });
  });
  registerGuiMutationHandler('invoker:planning-chat-reset', async (request: unknown) => {
    return resetPlanningChat(request as InAppPlanningResetRequest, {
      sessions: planningChatSessions,
      planningSessionStore: ownerMode ? persistence : undefined,
    });
  });
  registerGuiMutationHandler('invoker:planning-chat-set-terminal-mode', async (request: unknown) => {
    return setPlanningChatTerminalMode(request as InAppPlanningSetTerminalModeRequest, {
      sessions: planningChatSessions,
      planningSessionStore: ownerMode ? persistence : undefined,
    });
  });
  registerGuiMutationHandler('invoker:load-plan', async (planTextArg: unknown) => {
    const planText = String(planTextArg);
    await loadGeneratedPlanPreview(planText, { logLabel: 'load-plan' });
    publishOrchestratorSnapshotToRenderer();
  });

  if (process.env.NODE_ENV === 'test') {
    const injectTaskStates = async (updates: Array<{ taskId: string; changes: TaskStateChanges }>): Promise<void> => {
      for (const { taskId, changes } of updates) {
        const before = orchestrator.getTask(taskId);
        const previousSnapshot = rendererTaskFeed.getTaskSnapshot(taskId);
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
    registerGuiMutationHandler(
      'invoker:inject-task-states',
      async (updatesArg: unknown) => {
        const updates = updatesArg as Array<{ taskId: string; changes: TaskStateChanges }>;
        await injectTaskStates(updates);
      },
    );
    ipcMain.handle(
      'invoker:set-test-plan-from-goal-response',
      async (_event, response: { planYaml: string; planName: string } | null) => {
        testPlanFromGoalResponse = response;
      },
    );
    ipcMain.handle(
      'invoker:set-test-planning-chat-response',
      async (
        _event,
        response:
          | { planYaml: string; planName: string; reply?: string }
          | { throwError: string }
          | null,
      ) => {
        testPlanningChatResponse = response;
      },
    );
    registerGuiMutationHandler('invoker:seed-main-process-hitch-fixture', async () => {
      const seeded = seedMainProcessHitchFixture(persistence);
      orchestrator.syncAllFromDb();
      return seeded;
    });
    registerGuiMutationHandler('invoker:ingest-worker-actions', async (actionsArg: unknown) => {
      const actions = actionsArg as WorkerActionWrite[];
      for (const action of actions) {
        persistence.upsertWorkerAction(action);
      }
    });
    registerGuiMutationHandler('invoker:seed-stress-fixture', async (optionsArg: unknown) => {
      const options = optionsArg as StressFixtureOptions | undefined;
      const seeded = seedStressFixture(persistence, options);
      orchestrator.syncAllFromDb();
      return seeded;
    });
  }

  registerGuiMutationHandler('invoker:start', async () => {
    logger.info('start', { module: 'ipc' });
    const started = orchestrator.startExecution();
    logger.info(`startExecution returned ${started.length} tasks: [${started.map(t => t.id).join(', ')}]`, { module: 'ipc' });
    return started;
  });

  registerGuiMutationHandler('invoker:start-ready', async (requestArg: unknown) => {
    return executeStartReady(requestArg as StartReadyRequest | undefined);
  });

  registerGuiMutationHandler('invoker:resume-workflow', async () => {
    const workflows = persistence.listWorkflows();
    if (workflows.length === 0) {
      logger.info('resume-workflow: no workflows found', { module: 'ipc' });
      return null;
    }
    const result = executeStartReady({});
    const tasks = orchestrator.getAllTasks();
    logger.info(`resume-workflow: ${tasks.length} tasks loaded across ${workflows.length} workflows, ${result.started.length} started`, { module: 'ipc' });
    return { workflow: workflows[0], taskCount: tasks.length, startedCount: result.started.length };
  });

  registerGuiMutationHandler('invoker:stop', async () => {
    logger.info('stop — destroying all executors', { module: 'ipc' });
    const failInFlightTasks = (): void => {
      const allTasks = orchestrator.getAllTasks();
      for (const task of allTasks) {
        if (isTaskInFlightForForcedStop(task)) {
          logger.info(`stop — failing in-flight task "${task.id}" (${task.status})`, { module: 'ipc' });
          persistShutdownDiagnostic(task, persistence, {
            flushPendingOutput: rendererTaskFeed.flushTaskOutput,
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
    await sharedDeleteAllWorkflows({ logger, orchestrator, taskExecutor: getTaskExecutor() ?? undefined });
    await Promise.all(executorRegistry.getAll().map(f => f.destroyAll().catch(() => undefined)));

    orchestrator = new Orchestrator({
      persistence,
      messageBus,
      taskRepository: new SqliteTaskRepository(persistence),
      maxConcurrency: effectiveMaxConcurrency,
      defaultAutoFixRetries: resolveAutoFixRetries(invokerConfig),
      executorRoutingRules: invokerConfig.executorRoutingRules ?? [],
      defaultPoolId: invokerConfig.defaultPoolId,
      availablePoolIds: Object.keys(invokerConfig.executionPools ?? {}),
      deferRunningUntilLaunch: true,
    });
    commandService = new CommandService(
      orchestrator,
      buildCommandServiceInvalidationDeps(),
    );
    context.setOrchestrator(orchestrator);
    context.setCommandService(commandService);
    actions.refreshRuntime();
    rebuildTaskRunner();
    taskHandles.clear();
    rendererTaskFeed.resetSnapshotState();
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
    onMutationOwnerUnavailable: markDaemonOwnerUnavailable,
    recordStartupDuration,
    getTaskDeltaStreamSequence,
  });

  registerGuiMutationHandler('invoker:delete-all-workflows', async () => {
    logger.info('delete-all-workflows', { module: 'ipc' });
    assertDeleteAllEnabled();
    await sharedDeleteAllWorkflows({ logger, orchestrator, taskExecutor: getTaskExecutor() ?? undefined });
    taskHandles.clear();
    rendererTaskFeed.resetSnapshotState();
    requestWorkflowMetadataPublish('delete-all-workflows');
  });

  registerGuiMutationHandler('invoker:delete-all-workflows-bulk', async () => {
    logger.info('delete-all-workflows-bulk', { module: 'ipc' });
    assertDeleteAllEnabled();
    await sharedDeleteAllWorkflowsBulk({ logger, orchestrator, taskExecutor: getTaskExecutor() ?? undefined });
    taskHandles.clear();
    rendererTaskFeed.resetSnapshotState();
    requestWorkflowMetadataPublish('delete-all-workflows-bulk');
  });

  registerWorkflowScopedGuiMutationHandler(
    'invoker:delete-task',
    (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
    'high',
    async (taskIdArg: unknown) => {
      const taskId = String(taskIdArg);
      logger.info(`delete-task: "${taskId}"`, { module: 'ipc' });
      try {
        await performDeleteTask(taskId);
      } catch (err) {
        logger.error(`delete-task failed: ${err}`, { module: 'ipc' });
        throw err;
      }
    },
  );

  registerWorkflowScopedGuiMutationHandler(
    'invoker:delete-workflow',
    (workflowIdArg: unknown) => String(workflowIdArg),
    'high',
    async (workflowIdArg: unknown) => {
      const workflowId = String(workflowIdArg);
      logger.info(`delete-workflow: "${workflowId}"`, { module: 'ipc' });
      try {
        await performDeleteWorkflow(workflowId);
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

  registerGuiMutationHandler('invoker:start-worker', async (kindArg: unknown) => {
    if (!workerRuntimeController) {
      throw new Error('Worker runtime controller is unavailable');
    }
    return workerRuntimeController.start(String(kindArg));
  });

  registerGuiMutationHandler('invoker:stop-worker', async (kindArg: unknown) => {
    if (!workerRuntimeController) {
      throw new Error('Worker runtime controller is unavailable');
    }
    return workerRuntimeController.stop(String(kindArg));
  });

  registerGuiMutationHandler('invoker:set-workers-enabled', async (enabledArg: unknown) => {
    if (!workerRuntimeController) {
      throw new Error('Worker runtime controller is unavailable');
    }
    return workerRuntimeController.setGlobalEnabled(Boolean(enabledArg));
  });

  ipcMain.handle('invoker:get-queue-status', () => {
    return orchestrator.getQueueStatus();
  });
  ipcMain.handle('invoker:get-worker-status', async () => {
    if (!ownerMode) {
      try {
        const delegated = await messageBus.request<{ kind: string }, { workerStatus?: unknown }>(
          'headless.query',
          { kind: 'worker-status' },
        );
        if (delegated && typeof delegated === 'object' && 'workerStatus' in delegated) {
          return delegated.workerStatus;
        }
      } catch (err) {
        if (isMutationOwnerUnavailableError(err)) markDaemonOwnerUnavailable(err instanceof Error ? err.message : String(err));
        logger.warn(
          `get-worker-status owner delegation failed; falling back to local read-only snapshot: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { module: 'ipc' },
        );
      }
      return createLocalWorkerStatusSnapshot({
        registry: createRegisteredWorkerRegistry(),
        persistence,
        autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
      });
    }
    return workerRuntimeController?.snapshot() ?? createLocalWorkerStatusSnapshot({
      registry: createRegisteredWorkerRegistry(),
      persistence,
      autoStartKinds: AUTO_STARTED_OWNER_WORKER_KINDS,
    });
  });


  ipcMain.handle('invoker:get-action-graph', async () => {
    if (!ownerMode) {
      try {
        return await messageBus.request('headless.query', { kind: 'action-graph' });
      } catch (err) {
        if (isMutationOwnerUnavailableError(err)) markDaemonOwnerUnavailable(err instanceof Error ? err.message : String(err));
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
    recordRendererUiPerfMetric(uiPerfStats, metric, data);
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
      requestWorkflowMetadataPublish('set-merge-branch');
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
    rendererTaskFeed.setLastKnownWorkflowCount(workflows.length);
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
      `resolve-conflict: "${taskId}" agent=${agentName ?? DEFAULT_EXECUTION_AGENT} source=ipc route=resolveConflictAction`,
      { module: 'ipc' },
    );
    try {
      const result = await resolveConflictAction(taskId, {
        orchestrator,
        persistence,
        taskExecutor: requireTaskExecutor(),
        autoApproveAIFixes: resolveAutoApproveAIFixes(invokerConfig),
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
    async (...fixArgs: unknown[]) => {
    const { taskId, agentName, context } = parseFixWithAgentMutationArgs(fixArgs);
    const source = context.autoFix ? 'auto-fix' : 'ipc';
    try {
      const started = await executeFixWithAgentMutation(
        taskId,
        agentName,
        source,
        context.reviewGateContext,
      );
      await finalizeMutationWithGlobalTopup({
        orchestrator,
        taskExecutor: requireTaskExecutor(),
        logger,
        context: source === 'auto-fix' ? 'ipc.fix-with-agent.auto-fix' : 'ipc.fix-with-agent',
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
    'invoker:edit-task-model',
    (taskIdArg: unknown) => workflowIdForTaskArg(taskIdArg),
    'normal',
    async (taskIdArg: unknown, executionModelArg: unknown) => {
    const taskId = String(taskIdArg);
    const executionModel = typeof executionModelArg === 'string' ? executionModelArg : null;
    logger.info(`edit-task-model: "${taskId}" → "${executionModel ?? ''}"`, { module: 'ipc' });
    try {
      const envelope = makeEnvelope('edit-task-model', 'ui', 'task', { taskId, executionModel });
      const result = await commandService.editTaskModel(envelope);
      if (!result.ok) throw new Error(result.error.message);
      await dispatchStartedTasksWithGlobalTopup({
        orchestrator,
        taskExecutor: requireTaskExecutor(),
        logger,
        context: 'ipc.edit-task-model',
        started: result.data,
        scopedTaskIds: [taskId],
      });
    } catch (err) {
      logger.error(`edit-task-model failed: ${err}`, { module: 'ipc' });
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

  ipcMain.handle('invoker:get-execution-harnesses', () => {
    return agentRegistry.listExecutionHarnesses();
  });

  ipcMain.handle('invoker:get-planning-presets', () => listInAppPlanningPresets(loadConfig()));

  ipcMain.handle('invoker:get-execution-defaults', () => {
    return resolveDefaultTaskExecutionSettings(loadConfig());
  });

  ipcMain.handle('invoker:get-runtime-status', () => computeRuntimeStatus());

  ipcMain.handle('invoker:get-system-diagnostics', () => {
    return collectSystemDiagnostics({
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      bundledSkills: getBundledSkillsStatus(),
      cliInstaller: resolveCliInstallerStatus(buildCliInstallerContext()),
      config: resolveConfigFileState(),
      presets: invokerConfig.slackHarnessPresets ?? DEFAULT_SLACK_HARNESS_PRESETS,
      defaultPreset: invokerConfig.defaultSlackHarnessPreset ?? 'cursor+claude',
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
  ipcMain.handle('invoker:run-invoker-cli-setup', (_event, request) => {
    return runInvokerCliSetup(request, {
      cliPath: resolveSetupCliPath(),
      updateCli: () => updateInvokerCli(buildCliInstallerContext()),
      installBundledSkills: installPackagedSkills,
    });
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


}
