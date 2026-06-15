import type { BrowserWindow, IpcMain } from 'electron';
import type { Logger, SearchOptions } from '@invoker/contracts';
import { resolveInvokerHomeRoot } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { AgentRegistry } from '@invoker/execution-engine';
import type { Orchestrator, TaskDelta, TaskState } from '@invoker/workflow-core';
import type { MessageBus } from '@invoker/transport';
import { loadConfig } from './config.js';
import type { TaskSnapshotCache } from './delta-merge.js';

export interface RegisterReadOnlyIpcHandlersContext {
  ipcMain: IpcMain;
  logger: Logger;
  persistence: SQLiteAdapter;
  getOrchestrator: () => Orchestrator;
  agentRegistry: AgentRegistry;
  lastKnownTaskStates: TaskSnapshotCache;
  getMainWindow: () => BrowserWindow | null;
  sendTaskDeltaToRenderer: (delta: TaskDelta) => void;
  requestWorkflowMetadataPublish: (reason: string) => void;
  setLastKnownWorkflowCount: (count: number) => void;
  loadTaskByIdFromPersistence: (taskId: string) => TaskState | undefined;
  resolveAgentSession: (
    sessionId: string,
    agentName: string,
    agentRegistry: AgentRegistry,
    tasks: TaskState[],
  ) => Promise<unknown>;
  getOwnerMode?: () => boolean;
  getMessageBus?: () => Pick<MessageBus, 'request'>;
  timeStartupPhase: <T>(label: string, fn: () => T, fields?: () => Record<string, unknown>) => T;
  recordStartupDuration: (label: string, startedAtMs: number, fields?: Record<string, unknown>) => void;
  getTaskDeltaStreamSequence: () => number;
}

type DelegatedTasksSnapshot = {
  tasks: TaskState[];
  workflows: unknown[];
  streamSequence: number;
  invokerHomeRoot?: string;
};

function asDelegatedTasksSnapshot(value: unknown): DelegatedTasksSnapshot | null {
  if (!value || typeof value !== 'object') return null;

  const snapshot = value as Partial<DelegatedTasksSnapshot>;
  if (!Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.workflows)) {
    return null;
  }
  return snapshot as DelegatedTasksSnapshot;
}

function hasInvokerHomeMismatch(snapshot: DelegatedTasksSnapshot, localInvokerHomeRoot: string): boolean {
  return Boolean(snapshot.invokerHomeRoot && snapshot.invokerHomeRoot !== localInvokerHomeRoot);
}

export function registerReadOnlyIpcHandlers(context: RegisterReadOnlyIpcHandlersContext): void {
  const {
    ipcMain,
    logger,
    persistence,
    getOrchestrator,
    agentRegistry,
    lastKnownTaskStates,
    getMainWindow,
    sendTaskDeltaToRenderer,
    requestWorkflowMetadataPublish,
    setLastKnownWorkflowCount,
    loadTaskByIdFromPersistence,
    resolveAgentSession,
    getOwnerMode,
    getMessageBus,
    timeStartupPhase,
    recordStartupDuration,
    getTaskDeltaStreamSequence,
  } = context;

  async function delegateOwnerQuery<T>(kind: string, request: Record<string, unknown> = {}): Promise<T | null> {
    if (getOwnerMode?.() !== false) return null;
    try {
      return await getMessageBus?.().request<Record<string, unknown>, T>('headless.query', { kind, ...request }) ?? null;
    } catch (err) {
      logger.warn(
        `${kind} owner delegation failed; falling back to local read-only snapshot: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { module: 'ipc' },
      );
      return null;
    }
  }

  ipcMain.handle('invoker:list-workflows', () => persistence.listWorkflows());
  ipcMain.handle('invoker:get-execution-pools', () => Object.keys(loadConfig().executionPools ?? {}));

  ipcMain.handle('invoker:load-workflow', (_event, workflowId: string) => {
    logger.info(`load-workflow: "${workflowId}"`, { module: 'ipc' });
    const orchestrator = getOrchestrator();
    orchestrator.syncFromDb(workflowId);
    const tasks = persistence.loadTasks(workflowId);
    const workflow = persistence.loadWorkflow(workflowId);
    logger.info(`load-workflow: found ${tasks.length} tasks for "${workflow?.name ?? workflowId}"`, { module: 'ipc' });
    for (const task of tasks) {
      lastKnownTaskStates.set(task.id, JSON.stringify(task));
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendTaskDeltaToRenderer({ type: 'created', task });
      }
    }
    return { workflow, tasks };
  });

  ipcMain.handle('invoker:get-tasks', async (_event, forceRefresh?: boolean) => {
    const startedAtMs = Date.now();
    const orchestrator = getOrchestrator();
    const delegatedSnapshot = asDelegatedTasksSnapshot(await delegateOwnerQuery<DelegatedTasksSnapshot>(
      'tasks',
      { forceRefresh: forceRefresh === true },
    ));
    const localInvokerHomeRoot = resolveInvokerHomeRoot();
    const delegatedHomeMismatch = delegatedSnapshot
      ? hasInvokerHomeMismatch(delegatedSnapshot, localInvokerHomeRoot)
      : false;
    if (delegatedSnapshot && !delegatedHomeMismatch) {
      const previousTaskIds = new Set(lastKnownTaskStates.keys());
      lastKnownTaskStates.clear();
      for (const task of delegatedSnapshot.tasks) {
        lastKnownTaskStates.set(task.id, JSON.stringify(task));
        previousTaskIds.delete(task.id);
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          sendTaskDeltaToRenderer({ type: 'created', task });
        }
      }
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        for (const removedTaskId of previousTaskIds) {
          sendTaskDeltaToRenderer({ type: 'removed', taskId: removedTaskId, previousTaskStateVersion: 0 });
        }
        requestWorkflowMetadataPublish(forceRefresh ? 'get-tasks-force-refresh-delegated' : 'get-tasks-delegated');
      }
      setLastKnownWorkflowCount(delegatedSnapshot.workflows.length);
      recordStartupDuration(forceRefresh ? 'get-tasks.force-refresh.delegated-return' : 'get-tasks.delegated-return', startedAtMs, {
        taskCount: delegatedSnapshot.tasks.length,
        workflowCount: delegatedSnapshot.workflows.length,
        jsonSizeBytes: Buffer.byteLength(JSON.stringify(delegatedSnapshot), 'utf8'),
        streamSequence: delegatedSnapshot.streamSequence,
      });
      return delegatedSnapshot;
    }
    if (delegatedSnapshot && delegatedHomeMismatch) {
      logger.error(
        `tasks owner delegation ignored mismatched home root: owner="${delegatedSnapshot.invokerHomeRoot}" local="${localInvokerHomeRoot}"`,
        { module: 'ipc' },
      );
    }
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
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          sendTaskDeltaToRenderer({ type: 'created', task });
        }
      }
      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        for (const removedTaskId of previousTaskIds) {
          sendTaskDeltaToRenderer({ type: 'removed', taskId: removedTaskId, previousTaskStateVersion: 0 });
        }
        requestWorkflowMetadataPublish('get-tasks-force-refresh');
      }
      setLastKnownWorkflowCount(workflows.length);
    }
    logger.info(
      `get-tasks(forceRefresh=${forceRefresh ? 'true' : 'false'}) returning ${tasks.length} tasks, ${workflows.length} workflows`,
      { module: 'ipc' },
    );
    const streamSequence = getTaskDeltaStreamSequence();
    if (forceRefresh) {
      recordStartupDuration('get-tasks.force-refresh.return', startedAtMs, {
        taskCount: tasks.length,
        workflowCount: workflows.length,
        jsonSizeBytes: Buffer.byteLength(JSON.stringify({ tasks, workflows }), 'utf8'),
        streamSequence,
      });
    }
    return { tasks, workflows, streamSequence };
  });

  ipcMain.handle('invoker:get-events', (_event, taskId: string) => persistence.getEvents(taskId));
  ipcMain.handle('invoker:get-status', async () => (
    await delegateOwnerQuery('workflow-status') ?? getOrchestrator().getWorkflowStatus()
  ));
  ipcMain.handle('invoker:get-task-by-id', (_event, taskId: string) => loadTaskByIdFromPersistence(taskId) ?? null);
  ipcMain.handle('invoker:get-task-output', (_event, taskId: string) => persistence.getTaskOutput(taskId));
  ipcMain.handle('invoker:get-output-chunks', (_event, taskId: string) => persistence.getOutputChunks(taskId));
  ipcMain.handle('invoker:replay-output-from', (_event, taskId: string, fromOffset: number) =>
    persistence.replayOutputFrom(taskId, fromOffset)
  );
  ipcMain.handle('invoker:get-output-tail', (_event, taskId: string) => persistence.getOutputTail(taskId));
  ipcMain.handle('invoker:get-all-completed-tasks', () => persistence.loadAllCompletedTasks());

  ipcMain.handle('invoker:get-claude-session', async (_event, sessionId: string) => {
    logger.info(`get-claude-session: "${sessionId}"`, { module: 'ipc' });
    try {
      const orchestrator = getOrchestrator();
      return await resolveAgentSession(sessionId, 'claude', agentRegistry, orchestrator.getAllTasks());
    } catch (err) {
      logger.error(`get-claude-session failed: ${err}`, { module: 'ipc' });
      return null;
    }
  });

  ipcMain.handle('invoker:get-agent-session', async (_event, sessionId: string, agentName?: string) => {
    logger.info(`get-agent-session: "${sessionId}" agent="${agentName ?? 'claude'}"`, { module: 'ipc' });
    try {
      const orchestrator = getOrchestrator();
      return await resolveAgentSession(sessionId, agentName ?? 'claude', agentRegistry, orchestrator.getAllTasks());
    } catch (err) {
      logger.error(`get-agent-session failed: ${err}`, { module: 'ipc' });
      return null;
    }
  });
}
