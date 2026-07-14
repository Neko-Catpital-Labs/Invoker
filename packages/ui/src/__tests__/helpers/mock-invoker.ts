/**
 * Mock InvokerAPI factory for component tests.
 *
 * Provides a fully-typed mock of window.invoker with helpers to
 * set task state and fire delta subscriptions.
 */

import { vi } from 'vitest';
import type {
  InvokerAPI,
  TaskState,
  TaskDelta,
  TaskGraphEvent,
  TaskHistoryEntry,
  TaskEvent,
  WorkflowMeta,
  TaskStatus,
  TaskConfig,
  TaskExecution,
} from '../../types.js';
import type { ActionGraphResponse, InAppPlanningSessionSummary, RuntimeStatus, StartReadyResult, TerminalOutputEvent, WorkerStatusEntry, WorkerStatusSnapshot, WorkflowMutationAcceptedResult, WorkflowMutationFailedEvent } from '@invoker/contracts';

export interface MockInvoker {
  /** The mock InvokerAPI object installed on window.invoker. */
  api: InvokerAPI;
  /** Replace the task snapshot and fire matching 'created' graph events. */
  setTasks: (tasks: TaskState[], workflows?: WorkflowMeta[]) => void;
  /** Replace the history list returned by getHistoryTasks. */
  setHistoryTasks: (entries: TaskHistoryEntry[]) => void;
  /** Replace the events returned by getEvents for a task id. */
  setEvents: (taskId: string, events: TaskEvent[]) => void;
  /** Directly fire a task delta to subscribers. */
  fireDelta: (delta: TaskDelta) => void;
  /** Directly fire a task graph event to subscribers. */
  fireGraphEvent: (event: TaskGraphEvent) => void;
  /** Fire a workflows-changed event. */
  fireWorkflowsChanged: (workflows: WorkflowMeta[]) => void;
  /** Fire an embedded terminal output event to subscribers. */
  fireTerminalOutput: (event: TerminalOutputEvent) => void;
  /** Fire a workflow-mutation-failed event to subscribers. */
  fireWorkflowMutationFailed: (event: WorkflowMutationFailedEvent) => void;
  /** Fire a runtime-status event to subscribers. */
  fireRuntimeStatus: (status: RuntimeStatus) => void;
  /** Replace the action graph snapshot returned by getActionGraph. */
  setActionGraph: (response: ActionGraphResponse) => void;
  /** Replace the runtime status returned by getRuntimeStatus. */
  setRuntimeStatus: (status: RuntimeStatus) => void;
  /** Replace the worker status snapshot returned by getWorkerStatus. */
  setWorkerStatus: (status: WorkerStatusSnapshot) => void;
  /** Install the mock on window.invoker. */
  install: () => void;
  /** Remove window.invoker. */
  cleanup: () => void;
}


export function makePlanningSessionSummary(
  overrides: Partial<InAppPlanningSessionSummary> = {},
): InAppPlanningSessionSummary {
  return {
    id: 'saved-planning-1',
    title: 'Saved planning chat',
    status: 'draft_ready',
    presetKey: 'codex',
    messages: [
      {
        id: 1,
        role: 'user',
        text: 'Add README',
        createdAt: '2026-07-07T00:00:01.000Z',
      },
      {
        id: 2,
        role: 'assistant',
        text: 'Draft plan ready.',
        createdAt: '2026-07-07T00:00:02.000Z',
      },
    ],
    draftPlanAvailable: true,
    draftPlanSummary: { name: 'Saved plan', taskCount: 1, steps: ['Update README'] },
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:02.000Z',
    ...overrides,
  };
}
export function createMockInvoker(
  initialTasks: TaskState[] = [],
  initialWorkflows: WorkflowMeta[] = [],
): MockInvoker {
  let taskSnapshot = initialTasks;
  let workflowSnapshot = initialWorkflows;
  let historySnapshot: TaskHistoryEntry[] = [];
  const eventsByTask = new Map<string, TaskEvent[]>();
  let graphEventCallback: ((event: TaskGraphEvent) => void) | undefined;
  let workflowsCallback: ((workflows: unknown[]) => void) | undefined;
  const terminalOutputCallbacks = new Set<(event: TerminalOutputEvent) => void>();
  const workflowMutationFailedCallbacks = new Set<(event: WorkflowMutationFailedEvent) => void>();
  const runtimeStatusCallbacks = new Set<(status: RuntimeStatus) => void>();
  let actionGraphSnapshot: ActionGraphResponse = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    stallThresholdMs: 60_000,
    nodes: [],
    edges: [],
  };
  let runtimeStatus: RuntimeStatus = {
    ownerMode: true,
    readOnly: false,
    mode: 'local-owner',
  };
  let workerStatus: WorkerStatusSnapshot = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    workers: [],
  };

  const accepted = (channel: string, workflowId = 'wf-1'): WorkflowMutationAcceptedResult => ({
    ok: true,
    accepted: true,
    intentId: 1,
    workflowId,
    channel,
  });

  const api: InvokerAPI = {
    // Defer resolution one microtask so the startup snapshot is read after synchronous setTasks()
    // in tests (real IPC resolves later too).
    getTasks: vi.fn(
      () =>
        new Promise<{ tasks: TaskState[]; workflows: WorkflowMeta[]; streamSequence: number }>((resolve) => {
          queueMicrotask(() => {
            resolve({
              tasks: taskSnapshot,
              workflows: workflowSnapshot,
              streamSequence: 0,
            });
          });
        }),
    ),
    refreshTaskGraph: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          queueMicrotask(() => {
            graphEventCallback?.({
              type: 'snapshot',
              tasks: taskSnapshot,
              workflows: workflowSnapshot,
              reason: 'mock-refresh',
              streamSequence: 0,
            });
            resolve();
          });
        }),
    ),
    onTaskGraphEvent: vi.fn((cb: (event: TaskGraphEvent) => void) => {
      graphEventCallback = cb;
      return () => { graphEventCallback = undefined; };
    }),
    onWorkflowsChanged: vi.fn((cb: (workflows: unknown[]) => void) => {
      workflowsCallback = cb;
      return () => { workflowsCallback = undefined; };
    }),
    onTaskOutput: vi.fn(() => () => {}),
    onActivityLog: vi.fn(() => () => {}),
    loadPlan: vi.fn(async () => {}),
    planFromGoal: vi.fn(async () => ({
      ok: true,
      planName: 'Mock Plan',
      workflowId: 'wf-1',
    })),
    planningChatCreate: vi.fn(async () => ({
      ok: true,
      session: {
        id: 'session-1',
        title: 'Untitled plan',
        status: 'still_discussing',
        presetKey: 'codex',
        messages: [],
        draftPlanAvailable: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    })),
    planningChatList: vi.fn(async () => ({ ok: true, sessions: [] })),
    planningChatSend: vi.fn(async () => ({
      ok: true,
      sessionId: 'session-1',
      reply: 'I can help draft that.',
      draftPlanAvailable: false,
    })),
    planningChatSubmit: vi.fn(async () => ({
      ok: true,
      planName: 'Mock Plan',
      workflowId: 'wf-1',
    })),
    planningChatReset: vi.fn(async () => ({ ok: true })),
    planningTerminalOpen: vi.fn(async (planningSessionId: string) => ({
      opened: true,
      session: {
        sessionId: `mock-planning-terminal-${planningSessionId}`,
        taskId: `planning:${planningSessionId}`,
        kind: 'planning',
        planningSessionId,
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
      },
    })),
    planningTerminalList: vi.fn(async () => []),
    planningTerminalWrite: vi.fn(async () => ({ ok: true })),
    planningTerminalResize: vi.fn(async () => ({ ok: true })),
    planningTerminalClose: vi.fn(async () => ({ ok: true })),
    getPlanningPresets: vi.fn(async () => [
      { key: 'codex', label: 'Codex', tool: 'codex', isDefault: true },
      { key: 'omp+claude', label: 'Claude via OMP', tool: 'omp', model: 'claude', isDefault: false },
      { key: 'omp', label: 'OMP', tool: 'omp', isDefault: false },
    ]),
    start: vi.fn(async () => taskSnapshot),
    stop: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ total: 0, completed: 0, failed: 0, closed: 0, running: 0, pending: 0 })),
    provideInput: vi.fn(async () => accepted('invoker:provide-input')),
    approve: vi.fn(async () => accepted('invoker:approve')),
    reject: vi.fn(async () => accepted('invoker:reject')),
    selectExperiment: vi.fn(async () => accepted('invoker:select-experiment')),
    restartTask: vi.fn(async () => accepted('invoker:restart-task')),
    editTaskCommand: vi.fn(async () => accepted('invoker:edit-task-command')),
    editTaskPrompt: vi.fn(async () => accepted('invoker:edit-task-prompt')),
    editTaskPool: vi.fn(async () => accepted('invoker:edit-task-pool')),
    editTaskAgent: vi.fn(async () => accepted('invoker:edit-task-agent')),
    editTaskModel: vi.fn(async () => accepted('invoker:edit-task-model')),
    setTaskExternalGatePolicies: vi.fn(async () => accepted('invoker:set-task-external-gate-policies')),
    getRemoteTargets: vi.fn(async () => []),
    getExecutionPools: vi.fn(async () => ['mixed-local-ssh', 'pnpm-ssh']),
    getExecutionHarnesses: vi.fn(async () => [
      {
        name: 'claude',
        supportedModels: [{ id: 'sonnet', label: 'Claude Sonnet' }],
      },
      {
        name: 'codex',
        supportedModels: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex' }],
      },
      {
        name: 'omp',
        supportedModels: [
          { id: 'chatgpt-5.4', label: 'ChatGPT 5.4' },
          { id: 'openai/gpt-5-codex', label: 'OpenAI GPT-5 Codex' },
        ],
      },
    ]),
    getExecutionDefaults: vi.fn(async () => ({ executionAgent: 'codex' })),
    getRuntimeStatus: vi.fn(async () => runtimeStatus),
    getSystemDiagnostics: vi.fn(async () => ({
      platform: 'linux',
      arch: 'x64',
      appVersion: '0.0.1',
      isPackaged: false,
      tools: [{ id: 'codex', name: 'Codex', required: false, installed: true, installHint: 'Installed' }],
      bundledSkills: {
        available: false,
        promptRecommended: false,
        managedPrefix: 'invoker-',
        bundledSkillNames: [],
        targets: [
          { id: 'codex', name: 'Codex', path: '/tmp/.codex/skills', available: true, installed: false, upToDate: false, installedSkillNames: [] },
          { id: 'claude', name: 'Claude', path: '/tmp/.claude/skills', available: true, installed: false, upToDate: false, installedSkillNames: [] },
          { id: 'cursor', name: 'Cursor', path: '/tmp/.cursor/skills-cursor', available: true, installed: false, upToDate: false, installedSkillNames: [] },
        ],
        commandTargets: [],
        mcpTargets: [],
      },
    })),
    getBundledSkillsStatus: vi.fn(async () => ({
      available: false,
      promptRecommended: false,
      managedPrefix: 'invoker-',
      bundledSkillNames: [],
      targets: [
        { id: 'codex', name: 'Codex', path: '/tmp/.codex/skills', available: true, installed: false, upToDate: false, installedSkillNames: [] },
        { id: 'claude', name: 'Claude', path: '/tmp/.claude/skills', available: true, installed: false, upToDate: false, installedSkillNames: [] },
        { id: 'cursor', name: 'Cursor', path: '/tmp/.cursor/skills-cursor', available: true, installed: false, upToDate: false, installedSkillNames: [] },
      ],
      commandTargets: [],
      mcpTargets: [],
    })),
    installBundledSkills: vi.fn(async () => ({
      available: false,
      promptRecommended: false,
      managedPrefix: 'invoker-',
      bundledSkillNames: [],
      targets: [
        { id: 'codex', name: 'Codex', path: '/tmp/.codex/skills', available: true, installed: false, upToDate: false, installedSkillNames: [] },
        { id: 'claude', name: 'Claude', path: '/tmp/.claude/skills', available: true, installed: false, upToDate: false, installedSkillNames: [] },
        { id: 'cursor', name: 'Cursor', path: '/tmp/.cursor/skills-cursor', available: true, installed: false, upToDate: false, installedSkillNames: [] },
      ],
      commandTargets: [],
      mcpTargets: [],
    })),
    runInvokerCliSetup: vi.fn(async () => ({ ok: true, steps: [{ id: 'tools', name: 'Run setup', ok: true, output: 'setup ok' }] })),
    replaceTask: vi.fn(async () => accepted('invoker:replace-task')),
    getActivityLogs: vi.fn(async () => []),
    reportUiPerf: vi.fn(async () => {}),
    getUiPerfStats: vi.fn(async () => ({})),
    getEvents: vi.fn(async (taskId: string, options?: { limit: number; sortBy?: 'asc' | 'desc'; beforeId?: number }) => {
      const events = [...(eventsByTask.get(taskId) ?? [])];
      const sorted = options?.sortBy === 'desc'
        ? events.sort((a, b) => b.id - a.id)
        : options?.sortBy === 'asc'
          ? events.sort((a, b) => a.id - b.id)
          : events;
      const filtered = options?.beforeId === undefined
        ? sorted
        : sorted.filter((event) => event.id < options.beforeId!);
      return filtered.slice(0, options?.limit ?? filtered.length);
    }),
    getHistoryTasks: vi.fn(async () => historySnapshot),
    openTerminal: vi.fn(async (taskId: string) => ({
      opened: true,
      session: {
        sessionId: `mock-session-${taskId}`,
        taskId,
        status: 'running',
        mode: 'spawn',
        attached: false,
        createdAt: new Date('2025-01-01T00:00:00Z').toISOString(),
      },
    })),
    terminalList: vi.fn(async () => []),
    terminalWrite: vi.fn(async () => ({ ok: true })),
    terminalResize: vi.fn(async () => ({ ok: true })),
    terminalClose: vi.fn(async () => ({ ok: true })),
    onTerminalOutput: vi.fn((cb: (event: TerminalOutputEvent) => void) => {
      terminalOutputCallbacks.add(cb);
      return () => { terminalOutputCallbacks.delete(cb); };
    }),
    onTerminalExit: vi.fn(() => () => {}),
    onWorkflowMutationFailed: vi.fn((cb: (event: WorkflowMutationFailedEvent) => void) => {
      workflowMutationFailedCallbacks.add(cb);
      return () => { workflowMutationFailedCallbacks.delete(cb); };
    }),
    onRuntimeStatus: vi.fn((cb: (status: RuntimeStatus) => void) => {
      runtimeStatusCallbacks.add(cb);
      return () => { runtimeStatusCallbacks.delete(cb); };
    }),
    startReady: vi.fn(async () => ({
      preview: {
        readyTaskIds: [],
        recoverableTaskIds: [],
        failedWorkflowIds: [],
        skipped: {
          awaitingApproval: 0,
          reviewReady: 0,
          blocked: 0,
          failedTasks: 0,
        },
      },
      started: [],
      recreatedWorkflowIds: [],
      dryRun: false,
    } satisfies StartReadyResult)),
    resumeWorkflow: vi.fn(async () => null),
    listWorkflows: vi.fn(async () => workflowSnapshot),
    loadWorkflow: vi.fn(async () => ({ workflow: {}, tasks: [] })),
    getReviewGate: vi.fn(async () => null),
    deleteAllWorkflows: vi.fn(async () => {}),
    deleteAllWorkflowsBulk: vi.fn(async () => {}),
    deleteWorkflow: vi.fn(async () => accepted('invoker:delete-workflow')),
    deleteTask: vi.fn(async () => accepted('invoker:delete-task')),
    detachWorkflow: vi.fn(async () => {}),
    cleanupWorktrees: vi.fn(async () => ({ removed: [], errors: [] })),
    recreateWorkflow: vi.fn(async () => accepted('invoker:recreate-workflow')),
    recreateTask: vi.fn(async () => accepted('invoker:recreate-task')),
    recreateDownstream: vi.fn(async () => accepted('invoker:recreate-downstream')),
    retryWorkflow: vi.fn(async () => accepted('invoker:retry-workflow')),
    rebaseRetry: vi.fn(async () => accepted('invoker:rebase-retry')),
    rebaseRecreate: vi.fn(async () => accepted('invoker:rebase-recreate')),
    setMergeBranch: vi.fn(async () => accepted('invoker:set-merge-branch')),
    approveMerge: vi.fn(async () => accepted('invoker:approve-merge')),
    resolveConflict: vi.fn(async () => accepted('invoker:resolve-conflict')),
    fixWithAgent: vi.fn(async () => accepted('invoker:fix-with-agent')),
    setMergeMode: vi.fn(async () => accepted('invoker:set-merge-mode')),
    checkPrStatuses: vi.fn(async () => {}),
    cancelTask: vi.fn(async () => accepted('invoker:cancel-task')),
    cancelWorkflow: vi.fn(async () => accepted('invoker:cancel-workflow')),
    getQueueStatus: vi.fn(async () => ({
      maxConcurrency: 0,
      runningCount: 0,
      running: [],
      queued: [],
    })),
    getWorkerStatus: vi.fn(async () => workerStatus),
    getWorkerDecisions: vi.fn(async () => ({ actions: [], limit: 25, offset: 0, hasMore: false })),
    startWorker: vi.fn(async (kind: string) => {
      const row = workerStatus.workers.find((worker) => worker.kind === kind) ?? makeMockWorkerStatusEntry(kind);
      return row;
    }),
    stopWorker: vi.fn(async (kind: string) => {
      const row = workerStatus.workers.find((worker) => worker.kind === kind) ?? makeMockWorkerStatusEntry(kind);
      return row;
    }),
    getActionGraph: vi.fn(async () => actionGraphSnapshot),
    getClaudeSession: vi.fn(async () => null),
    getAgentSession: vi.fn(async () => null),
  };

  function setTasks(tasks: TaskState[], workflows?: WorkflowMeta[]) {
    taskSnapshot = tasks;
    if (workflows) {
      workflowSnapshot = workflows;
    }

    queueMicrotask(() => {
      if (workflows) {
        workflowsCallback?.(workflows);
      }

      // Fire created graph events for each task after subscribers attach.
      for (const task of tasks) {
        graphEventCallback?.({ type: 'delta', delta: { type: 'created', task }, workflowRollups: [] });
      }
    });
  }

  function setHistoryTasks(entries: TaskHistoryEntry[]) {
    historySnapshot = entries;
  }

  function setEvents(taskId: string, events: TaskEvent[]) {
    eventsByTask.set(taskId, events);
  }

  function setActionGraph(response: ActionGraphResponse) {
    actionGraphSnapshot = response;
  }
  function setRuntimeStatus(status: RuntimeStatus) {
    runtimeStatus = status;
  }
  function setWorkerStatus(status: WorkerStatusSnapshot) {
    workerStatus = status;
  }


  function fireDelta(delta: TaskDelta) {
    graphEventCallback?.({ type: 'delta', delta, workflowRollups: [] });
  }
  function fireGraphEvent(event: TaskGraphEvent) {
    graphEventCallback?.(event);
  }


  function fireWorkflowsChanged(workflows: WorkflowMeta[]) {
    workflowSnapshot = workflows;
    workflowsCallback?.(workflows);
  }

  function fireTerminalOutput(event: TerminalOutputEvent) {
    for (const callback of terminalOutputCallbacks) {
      callback(event);
    }
  }

  function fireWorkflowMutationFailed(event: WorkflowMutationFailedEvent) {
    for (const callback of workflowMutationFailedCallbacks) {
      callback(event);
    }
  }

  function fireRuntimeStatus(status: RuntimeStatus) {
    runtimeStatus = status;
    for (const callback of runtimeStatusCallbacks) {
      callback(status);
    }
  }

  function install() {
    (window as unknown as { invoker: InvokerAPI }).invoker = api;
    (window as unknown as { __INVOKER_BOOTSTRAP__?: { tasks: TaskState[]; workflows: WorkflowMeta[]; runtimeStatus?: RuntimeStatus } }).__INVOKER_BOOTSTRAP__ = {
      tasks: taskSnapshot,
      workflows: workflowSnapshot,
      runtimeStatus,
    };
  }

  function cleanup() {
    delete (window as unknown as { invoker?: InvokerAPI }).invoker;
    delete (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__;
    terminalOutputCallbacks.clear();
    workflowMutationFailedCallbacks.clear();
    runtimeStatusCallbacks.clear();
    eventsByTask.clear();
    historySnapshot = [];
  }

  return {
    api,
    setTasks,
    setHistoryTasks,
    setEvents,
    setActionGraph,
    setRuntimeStatus,
    setWorkerStatus,
    fireDelta,
    fireGraphEvent,
    fireWorkflowsChanged,
    fireTerminalOutput,
    fireWorkflowMutationFailed,
    fireRuntimeStatus,
    install,
    cleanup,
  };
}

function makeMockWorkerStatusEntry(kind: string): WorkerStatusEntry {
  return {
    kind,
    note: '',
    lifecycle: 'stopped',
    policy: 'unknown',
    autoStarts: false,
    startable: false,
    stoppable: false,
    recentActions: [],
  };
}

/** Create a minimal TaskState for testing. */
export function makeUITask(overrides: Partial<TaskState> & {
  id?: string;
  description?: string;
  status?: TaskStatus;
  workflowId?: string;
  isMergeNode?: boolean;
  command?: string;
  prompt?: string;
} = {}): TaskState {
  const {
    workflowId,
    isMergeNode,
    command,
    prompt,
    ...rest
  } = overrides;

  return {
    id: 'task-1',
    description: 'Test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2025-01-01T00:00:00Z'),
    config: {
      workflowId,
      isMergeNode,
      command,
      prompt,
      ...((overrides as any).config ?? {}),
    } as TaskConfig,
    execution: ((overrides as any).execution ?? {}) as TaskExecution,
    ...rest,
  } as TaskState;
}
