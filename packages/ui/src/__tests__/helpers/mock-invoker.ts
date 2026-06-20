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
  WorkflowMeta,
  TaskStatus,
  TaskConfig,
  TaskExecution,
} from '../../types.js';
import type { TerminalOutputEvent } from '@invoker/contracts';

export interface MockInvoker {
  /** The mock InvokerAPI object installed on window.invoker. */
  api: InvokerAPI;
  /** Replace the task snapshot and fire matching 'created' graph events. */
  setTasks: (tasks: TaskState[], workflows?: WorkflowMeta[]) => void;
  /** Directly fire a task delta to subscribers. */
  fireDelta: (delta: TaskDelta) => void;
  /** Directly fire a task graph event to subscribers. */
  fireGraphEvent: (event: TaskGraphEvent) => void;
  /** Fire a workflows-changed event. */
  fireWorkflowsChanged: (workflows: WorkflowMeta[]) => void;
  /** Fire an embedded terminal output event to subscribers. */
  fireTerminalOutput: (event: TerminalOutputEvent) => void;
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
  let graphEventCallback: ((event: TaskGraphEvent) => void) | undefined;
  let workflowsCallback: ((workflows: unknown[]) => void) | undefined;
  const terminalOutputCallbacks = new Set<(event: TerminalOutputEvent) => void>();

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
    start: vi.fn(async () => taskSnapshot),
    stop: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ total: 0, completed: 0, failed: 0, closed: 0, running: 0, pending: 0 })),
    provideInput: vi.fn(async () => {}),
    approve: vi.fn(async () => {}),
    reject: vi.fn(async () => {}),
    selectExperiment: vi.fn(async () => {}),
    restartTask: vi.fn(async () => {}),
    editTaskCommand: vi.fn(async () => {}),
    editTaskPool: vi.fn(async () => {}),
    editTaskAgent: vi.fn(async () => {}),
    setTaskExternalGatePolicies: vi.fn(async () => {}),
    getRemoteTargets: vi.fn(async () => []),
    getExecutionPools: vi.fn(async () => ['mixed-local-ssh', 'pnpm-ssh']),
    getExecutionAgents: vi.fn(async () => ['claude', 'codex']),
    getSystemDiagnostics: vi.fn(async () => ({
      platform: 'linux',
      arch: 'x64',
      appVersion: '0.0.1',
      isPackaged: false,
      tools: [],
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
    })),
    replaceTask: vi.fn(async () => []),
    getActivityLogs: vi.fn(async () => []),
    getEvents: vi.fn(async () => []),
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
    resumeWorkflow: vi.fn(async () => null),
    listWorkflows: vi.fn(async () => workflowSnapshot),
    loadWorkflow: vi.fn(async () => ({ workflow: {}, tasks: [] })),
    deleteAllWorkflows: vi.fn(async () => {}),
    deleteAllWorkflowsBulk: vi.fn(async () => {}),
    deleteWorkflow: vi.fn(async () => {}),
    cleanupWorktrees: vi.fn(async () => ({ removed: [], errors: [] })),
    recreateWorkflow: vi.fn(async () => {}),
    recreateTask: vi.fn(async () => {}),
    recreateDownstream: vi.fn(async () => {}),
    retryWorkflow: vi.fn(async () => {}),
    rebaseRetry: vi.fn(async () => ({ success: true, rebasedBranches: [], errors: [] })),
    rebaseRecreate: vi.fn(async () => ({ success: true, rebasedBranches: [], errors: [] })),
    setMergeBranch: vi.fn(async () => {}),
    approveMerge: vi.fn(async () => {}),
    resolveConflict: vi.fn(async () => {}),
    fixWithAgent: vi.fn(async () => {}),
    setMergeMode: vi.fn(async () => {}),
    checkPrStatuses: vi.fn(async () => {}),
    cancelTask: vi.fn(async () => ({ cancelled: [], runningCancelled: [] })),
    cancelWorkflow: vi.fn(async () => ({ cancelled: [], runningCancelled: [] })),
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
    if (workflows) {
      workflowSnapshot = workflows;
    }

    queueMicrotask(() => {
      if (workflows) {
        workflowsCallback?.(workflows);
      }

      // Fire created graph events for each task after subscribers attach.
      for (const task of tasks) {
        graphEventCallback?.({ type: 'delta', delta: { type: 'created', task } });
      }
    });
  }

  function fireDelta(delta: TaskDelta) {
    graphEventCallback?.({ type: 'delta', delta });
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

  function install() {
    (window as unknown as { invoker: InvokerAPI }).invoker = api;
    (window as unknown as { __INVOKER_BOOTSTRAP__?: { tasks: TaskState[]; workflows: WorkflowMeta[] } }).__INVOKER_BOOTSTRAP__ = {
      tasks: taskSnapshot,
      workflows: workflowSnapshot,
    };
  }

  function cleanup() {
    terminalOutputCallbacks.clear();
    delete (window as unknown as { invoker?: unknown }).invoker;
    delete (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__;
  }

  return { api, setTasks, fireDelta, fireGraphEvent, fireWorkflowsChanged, fireTerminalOutput, install, cleanup };
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
