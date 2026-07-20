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
  InAppPlanningSessionSummary,
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
        role: 'system',
        text: 'Ask Invoker what you want to build.',
        tone: 'muted',
        createdAt: '2026-07-07T00:00:00.000Z',
      },
      {
        id: 2,
        role: 'assistant',
        text: 'Draft plan ready.',
        createdAt: '2026-07-07T00:00:01.000Z',
      },
    ],
    draftPlanAvailable: true,
    draftPlanSummary: { name: 'Saved plan', taskCount: 1, steps: ['Update README'] },
    draftPlanText: 'name: Saved plan\ntasks:\n  - id: update-readme\n    description: Update README\n',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:01.000Z',
    ...overrides,
  };
}

export function createMockInvoker(
  initialTasks: TaskState[] = [],
  initialWorkflows: WorkflowMeta[] = [],
): MockInvoker {
  let taskSnapshot = initialTasks;
  let workflowSnapshot = initialWorkflows;
  let planningSessions: InAppPlanningSessionSummary[] = [];
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
    planFromGoal: vi.fn(async () => ({ ok: true, planName: 'Mock plan', workflowId: 'wf-1' })),
    planningChatCreate: vi.fn(async (request) => {
      const session = makePlanningSessionSummary({
        id: 'planning-1',
        title: request?.title ?? 'Untitled plan',
        presetKey: request?.presetKey ?? 'codex',
        status: 'still_discussing',
        messages: [],
        draftPlanAvailable: false,
        draftPlanSummary: undefined,
        draftPlanText: undefined,
      });
      planningSessions = [session, ...planningSessions];
      return { ok: true, session };
    }),
    planningChatList: vi.fn(async () => ({ ok: true, sessions: planningSessions })),
    planningChatGet: vi.fn(async (request) => {
      const session = planningSessions.find((candidate) => candidate.id === request.sessionId);
      return session
        ? { ok: true, session }
        : { ok: false, error: 'Planning session not found.' };
    }),
    planningChatSend: vi.fn(async (request) => {
      const sessionId = request.sessionId ?? 'planning-1';
      const draftPlanText = 'name: Mock plan\ntasks:\n  - id: update-readme\n    description: Update README\n';
      return {
        ok: true,
        sessionId,
        reply: 'Draft plan ready.',
        draftPlanAvailable: true,
        draftPlanSummary: { name: 'Mock plan', taskCount: 1, steps: ['Update README'] },
        draftPlanText,
      };
    }),
    planningChatSubmit: vi.fn(async () => ({ ok: true, planName: 'Mock plan', workflowId: 'wf-1' })),
    planningChatReset: vi.fn(async (request) => {
      planningSessions = planningSessions.filter((session) => session.id !== request.sessionId);
      return { ok: true };
    }),
    getPlanningPresets: vi.fn(async () => [
      { key: 'codex', label: 'Codex', tool: 'codex', isDefault: true },
    ]),
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
    openTerminal: vi.fn(async () => ({ opened: true })),
    resumeWorkflow: vi.fn(async () => null),
    listWorkflows: vi.fn(async () => []),
    loadWorkflow: vi.fn(async () => ({ workflow: {}, tasks: [] })),
    deleteAllWorkflows: vi.fn(async () => {}),
    deleteAllWorkflowsBulk: vi.fn(async () => {}),
    deleteWorkflow: vi.fn(async () => {}),
    cleanupWorktrees: vi.fn(async () => ({ removed: [], errors: [] })),
    recreateWorkflow: vi.fn(async () => {}),
    recreateTask: vi.fn(async () => {}),
    retryWorkflow: vi.fn(async () => {}),
    rebaseAndRetry: vi.fn(async () => ({ success: true, rebasedBranches: [], errors: [] })),
    recreateWithRebase: vi.fn(async () => ({ success: true, rebasedBranches: [], errors: [] })),
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
    (window as unknown as { __INVOKER_BOOTSTRAP__?: { tasks: TaskState[]; workflows: WorkflowMeta[] } }).__INVOKER_BOOTSTRAP__ = {
      tasks: taskSnapshot,
      workflows: workflowSnapshot,
    };
  }

  function cleanup() {
    delete (window as unknown as { invoker?: unknown }).invoker;
    delete (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__;
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
