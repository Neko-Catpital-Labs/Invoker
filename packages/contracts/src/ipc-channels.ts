/**
 * IPC Channel Registry — Single source of truth for every Electron IPC channel.
 *
 * Each entry maps a channel name to its request tuple and response type.
 * The `InvokerAPI` type is derived from this registry, not hand-written.
 *
 * Conventions:
 *   - Invoke channels use ipcMain.handle / ipcRenderer.invoke (request → response).
 *   - Event channels use webContents.send / ipcRenderer.on (main pushes to renderer).
 */

import type { TaskState, TaskDelta, TaskStateChanges } from '@invoker/workflow-graph';

// ── Types used by IPC channels ──────────────────────────────
// These were previously in packages/app/src/types.ts.
// Defined here so contracts stays independent of packages/app.

export interface TaskReplacementDef {
  id: string;
  description: string;
  command?: string;
  prompt?: string;
  dependencies?: string[];
  executorType?: string;
  executionAgent?: string;
}

export interface WorkflowMeta {
  id: string;
  name: string;
  status: string;
  baseBranch?: string;
  featureBranch?: string;
  onFinish?: string;
  mergeMode?: string;
}

export interface WorkflowStatus {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
}

export interface TaskOutputData {
  taskId: string;
  data: string;
}

export interface ActivityLogEntry {
  id: number;
  timestamp: string;
  source: string;
  level: string;
  message: string;
}

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ExternalGatePolicyUpdate {
  workflowId: string;
  taskId?: string;
  gatePolicy: 'completed' | 'review_ready';
}

export interface TaskEvent {
  id: number;
  taskId: string;
  eventType: string;
  payload?: string;
  createdAt: string;
}

export interface QueueStatus {
  maxConcurrency: number;
  runningCount: number;
  running: Array<{ taskId: string; description: string }>;
  queued: Array<{ taskId: string; priority: number; description: string }>;
}

export interface ResumeWorkflowResult {
  workflow: { id: string; name: string; status: string };
  taskCount: number;
  startedCount: number;
}

export interface WorkflowListEntry {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface RebaseAndRetryResult {
  success: boolean;
  rebasedBranches: string[];
  errors: string[];
}

export interface CancelResult {
  cancelled: string[];
  runningCancelled: string[];
}

export interface CleanupWorktreesResult {
  removed: string[];
  errors: string[];
}

// ── Invoke Channel Registry ─────────────────────────────────
// Each key is the channel name string; value is { request, response }.
// `request` is a tuple of the arguments passed after the channel name.

export const IpcChannels = {
  // Plan & Workflow Management
  'invoker:load-plan': {} as {
    request: [planText: string];
    response: void;
  },
  'invoker:start': {} as {
    request: [];
    response: TaskState[];
  },
  'invoker:resume-workflow': {} as {
    request: [];
    response: ResumeWorkflowResult | null;
  },
  'invoker:stop': {} as {
    request: [];
    response: void;
  },
  'invoker:clear': {} as {
    request: [];
    response: void;
  },
  'invoker:list-workflows': {} as {
    request: [];
    response: WorkflowListEntry[];
  },
  'invoker:delete-all-workflows': {} as {
    request: [];
    response: void;
  },
  'invoker:delete-workflow': {} as {
    request: [workflowId: string];
    response: void;
  },
  'invoker:load-workflow': {} as {
    request: [workflowId: string];
    response: { workflow: unknown; tasks: unknown[] };
  },

  // Task Queries
  'invoker:get-tasks': {} as {
    request: [forceRefresh?: boolean];
    response: { tasks: TaskState[]; workflows: WorkflowMeta[] };
  },
  'invoker:get-events': {} as {
    request: [taskId: string];
    response: TaskEvent[];
  },
  'invoker:get-status': {} as {
    request: [];
    response: WorkflowStatus;
  },
  'invoker:get-task-output': {} as {
    request: [taskId: string];
    response: string;
  },
  'invoker:get-all-completed-tasks': {} as {
    request: [];
    response: Array<TaskState & { workflowName: string }>;
  },

  // Task Actions
  'invoker:provide-input': {} as {
    request: [taskId: string, input: string];
    response: void;
  },
  'invoker:approve': {} as {
    request: [taskId: string];
    response: void;
  },
  'invoker:reject': {} as {
    request: [taskId: string, reason?: string];
    response: void;
  },
  'invoker:select-experiment': {} as {
    request: [taskId: string, experimentId: string | string[]];
    response: void;
  },
  /**
   * @deprecated Step 13 (`docs/architecture/task-invalidation-roadmap.md`):
   * `invoker:restart-task` is the legacy channel name from when
   * `restartTask` was the overloaded "retry-or-recreate" verb the
   * chart's "Naming inconsistency" section flagged. The channel
   * itself is preserved for UI compatibility but its handler in
   * `main.ts` now routes through `commandService.retryTask` →
   * `Orchestrator.retryTask` (retry-class semantics: preserves
   * branch/workspacePath lineage). Prefer the explicit channels —
   * `invoker:retry-task` (when wired) for retry-class invalidation
   * or `invoker:recreate-task` for recreate-class invalidation.
   * Once UI is migrated this channel can be removed.
   */
  'invoker:restart-task': {} as {
    request: [taskId: string];
    response: void;
  },
  'invoker:cancel-task': {} as {
    request: [taskId: string];
    response: CancelResult;
  },
  'invoker:cancel-workflow': {} as {
    request: [workflowId: string];
    response: CancelResult;
  },

  // Task Editing
  'invoker:edit-task-command': {} as {
    request: [taskId: string, newCommand: string];
    response: void;
  },
  'invoker:edit-task-type': {} as {
    request: [taskId: string, executorType: string, remoteTargetId?: string];
    response: void;
  },
  'invoker:edit-task-agent': {} as {
    request: [taskId: string, agentName: string];
    response: void;
  },
  'invoker:set-task-external-gate-policies': {} as {
    request: [taskId: string, updates: ExternalGatePolicyUpdate[]];
    response: void;
  },
  'invoker:replace-task': {} as {
    request: [taskId: string, replacementTasks: TaskReplacementDef[]];
    response: TaskState[];
  },

  // Session & Agent Access
  'invoker:get-claude-session': {} as {
    request: [sessionId: string];
    response: ClaudeMessage[] | null;
  },
  'invoker:get-agent-session': {} as {
    request: [sessionId: string, agentName?: string];
    response: ClaudeMessage[] | null;
  },

  // Workflow Mutation & Merge
  'invoker:recreate-workflow': {} as {
    request: [workflowId: string];
    response: void;
  },
  'invoker:recreate-task': {} as {
    request: [taskId: string];
    response: void;
  },
  'invoker:retry-workflow': {} as {
    request: [workflowId: string];
    response: void;
  },
  'invoker:rebase-and-retry': {} as {
    request: [mergeTaskId: string];
    response: RebaseAndRetryResult;
  },
  'invoker:set-merge-branch': {} as {
    request: [workflowId: string, baseBranch: string];
    response: void;
  },
  'invoker:set-merge-mode': {} as {
    request: [workflowId: string, mergeMode: string];
    response: void;
  },
  'invoker:approve-merge': {} as {
    request: [workflowId: string];
    response: void;
  },

  // PR & Conflict Resolution
  'invoker:check-pr-statuses': {} as {
    request: [];
    response: void;
  },
  'invoker:check-pr-status': {} as {
    request: [];
    response: void;
  },
  'invoker:resolve-conflict': {} as {
    request: [taskId: string, agentName?: string];
    response: void;
  },
  'invoker:fix-with-agent': {} as {
    request: [taskId: string, agentName?: string];
    response: void;
  },

  // Queue & Configuration
  'invoker:get-queue-status': {} as {
    request: [];
    response: QueueStatus;
  },
  'invoker:get-remote-targets': {} as {
    request: [];
    response: string[];
  },
  'invoker:get-execution-agents': {} as {
    request: [];
    response: string[];
  },

  // Performance & Activity
  'invoker:report-ui-perf': {} as {
    request: [metric: string, data?: Record<string, unknown>];
    response: void;
  },
  'invoker:get-ui-perf-stats': {} as {
    request: [];
    response: Record<string, unknown>;
  },
  'invoker:get-activity-logs': {} as {
    request: [];
    response: ActivityLogEntry[];
  },

  // Terminal
  'invoker:open-terminal': {} as {
    request: [taskId: string];
    response: { opened: boolean; reason?: string };
  },

  // Worktree Cleanup
  'invoker:cleanup-worktrees': {} as {
    request: [];
    response: CleanupWorktreesResult;
  },

} as const;

// ── Test-Only Invoke Channels ───────────────────────────────
// These channels are only registered in the preload when NODE_ENV === 'test'.
// They are derived as optional (Partial) in InvokerAPI.

export const IpcTestOnlyChannels = {
  'invoker:inject-task-states': {} as {
    request: [updates: Array<{ taskId: string; changes: TaskStateChanges }>];
    response: void;
  },
} as const;

// ── Event Channel Registry ──────────────────────────────────
// Pushed from main → renderer via webContents.send.

export const IpcEventChannels = {
  'invoker:task-delta': {} as {
    payload: TaskDelta;
  },
  'invoker:task-output': {} as {
    payload: TaskOutputData;
  },
  'invoker:activity-log': {} as {
    payload: ActivityLogEntry[];
  },
  'invoker:workflows-changed': {} as {
    payload: unknown[];
  },
} as const;

// ── Type Utilities ──────────────────────────────────────────

/** Strip the `invoker:` prefix from a channel name. */
type StripPrefix<S extends string> =
  S extends `invoker:${infer Rest}` ? Rest : S;

/** Convert a kebab-case string to camelCase. */
type KebabToCamel<S extends string> =
  S extends `${infer Head}-${infer Tail}`
    ? `${Head}${Capitalize<KebabToCamel<Tail>>}`
    : S;

/** Convert an IPC channel name to its API method name. e.g. 'invoker:load-plan' → 'loadPlan' */
type ChannelToMethod<S extends string> = KebabToCamel<StripPrefix<S>>;

// ── Derived InvokerAPI ──────────────────────────────────────

type InvokeChannels = typeof IpcChannels;
type TestOnlyChannels = typeof IpcTestOnlyChannels;
type EventChannels = typeof IpcEventChannels;

/** Invoke methods: each channel becomes an async method on the API. */
type InvokeMethods = {
  [K in keyof InvokeChannels as ChannelToMethod<K & string>]:
    (...args: InvokeChannels[K]['request']) => Promise<InvokeChannels[K]['response']>;
};

/** Test-only invoke methods: optional because they are only registered in test environments. */
type TestOnlyMethods = {
  [K in keyof TestOnlyChannels as ChannelToMethod<K & string>]:
    (...args: TestOnlyChannels[K]['request']) => Promise<TestOnlyChannels[K]['response']>;
};

/** Event subscriptions: each event channel becomes an `on*` callback registration. */
type EventMethods = {
  [K in keyof EventChannels as `on${Capitalize<ChannelToMethod<K & string>>}`]:
    (cb: (data: EventChannels[K]['payload']) => void) => () => void;
};

/**
 * The full IPC API surface exposed to the renderer via `window.invoker`.
 * Derived from the channel registries — not hand-written.
 * Test-only methods are Partial because they are only registered when NODE_ENV === 'test'.
 */
export type InvokerAPI = InvokeMethods & EventMethods & Partial<TestOnlyMethods>;
