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
  WorkflowMeta,
  TaskStatus,
  TaskConfig,
  TaskExecution,
} from '../../types.js';

export interface MockInvoker {
  /** The mock InvokerAPI object installed on window.invoker. */
  api: InvokerAPI;
  /** Replace the task snapshot and fire 'created' deltas for each task. */
  setTasks: (tasks: TaskState[], workflows?: WorkflowMeta[]) => void;
  /** Directly fire a task delta to subscribers. */
  fireDelta: (delta: TaskDelta) => void;
  /** Fire a workflows-changed event. */
  fireWorkflowsChanged: (workflows: WorkflowMeta[]) => void;
  /** Install the mock on window.invoker. */
  install: () => void;
  /** Remove window.invoker. */
  cleanup: () => void;
}

export function createMockInvoker(
  initialTasks: TaskState[] = [],
  initialWorkflows: WorkflowMeta[] = [],
): MockInvoker {
  let taskSnapshot = initialTasks;
  let workflowSnapshot = initialWorkflows;
  let deltaCallback: ((delta: TaskDelta) => void) | undefined;
  let workflowsCallback: ((workflows: unknown[]) => void) | undefined;

  const api: InvokerAPI = {
    // Defer resolution one microtask so snapshot is read after synchronous setTasks()
    // in tests (useTasks fetchAll races mount vs setTasks; real IPC resolves later too).
    getTasks: vi.fn(
      (_forceRefresh?: boolean) =>
        new Promise<{ tasks: TaskState[]; workflows: WorkflowMeta[] }>((resolve) => {
          queueMicrotask(() => {
            resolve({
              tasks: taskSnapshot,
              workflows: workflowSnapshot,
            });
          });
        }),
    ),
    onTaskDelta: vi.fn((cb: (delta: TaskDelta) => void) => {
      deltaCallback = cb;
      return () => { deltaCallback = undefined; };
    }),
    onWorkflowsChanged: vi.fn((cb: (workflows: unknown[]) => void) => {
      workflowsCallback = cb;
      return () => { workflowsCallback = undefined; };
    }),
    onTaskOutput: vi.fn(() => () => {}),
    onActivityLog: vi.fn(() => () => {}),
    loadPlan: vi.fn(async () => {}),
    start: vi.fn(async () => taskSnapshot),
    stop: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ total: 0, completed: 0, failed: 0, running: 0, pending: 0 })),
    provideInput: vi.fn(async () => {}),
    approve: vi.fn(async () => {}),
    reject: vi.fn(async () => {}),
    selectExperiment: vi.fn(async () => {}),
    restartTask: vi.fn(async () => {}),
    editTaskCommand: vi.fn(async () => {}),
    editTaskType: vi.fn(async () => {}),
    editTaskAgent: vi.fn(async () => {}),
    getRemoteTargets: vi.fn(async () => []),
    getExecutionAgents: vi.fn(async () => ['claude', 'codex']),
    replaceTask: vi.fn(async () => []),
    getActivityLogs: vi.fn(async () => []),
    getEvents: vi.fn(async () => []),
    openTerminal: vi.fn(async () => ({ opened: true })),
    resumeWorkflow: vi.fn(async () => null),
    listWorkflows: vi.fn(async () => []),
    loadWorkflow: vi.fn(async () => ({ workflow: {}, tasks: [] })),
    deleteAllWorkflows: vi.fn(async () => {}),
    deleteWorkflow: vi.fn(async () => {}),
    cleanupWorktrees: vi.fn(async () => ({ removed: [], errors: [] })),
    recreateWorkflow: vi.fn(async () => {}),
    retryWorkflow: vi.fn(async () => {}),
    rebaseAndRetry: vi.fn(async () => ({ success: true, rebasedBranches: [], errors: [] })),
    setMergeBranch: vi.fn(async () => {}),
    approveMerge: vi.fn(async () => {}),
    resolveConflict: vi.fn(async () => {}),
    fixWithAgent: vi.fn(async () => {}),
    setMergeMode: vi.fn(async () => {}),
    checkPrStatuses: vi.fn(async () => {}),
    cancelTask: vi.fn(async () => ({ cancelled: [], runningCancelled: [] })),
    getQueueStatus: vi.fn(async () => ({
      maxConcurrency: 0,
      runningCount: 0,
      running: [],
      queued: [],
    })),
    getClaudeSession: vi.fn(async () => null),
    getAgentSession: vi.fn(async () => null),
  };

  function setTasks(tasks: TaskState[], workflows?: WorkflowMeta[]) {
    taskSnapshot = tasks;
    if (workflows) workflowSnapshot = workflows;

    // Fire created deltas for each task
    for (const task of tasks) {
      deltaCallback?.({ type: 'created', task });
    }
  }

  function fireDelta(delta: TaskDelta) {
    deltaCallback?.(delta);
  }

  function fireWorkflowsChanged(workflows: WorkflowMeta[]) {
    workflowSnapshot = workflows;
    workflowsCallback?.(workflows);
  }

  function install() {
    (window as unknown as { invoker: InvokerAPI }).invoker = api;
  }

  function cleanup() {
    delete (window as unknown as { invoker?: unknown }).invoker;
  }

  return { api, setTasks, fireDelta, fireWorkflowsChanged, install, cleanup };
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
