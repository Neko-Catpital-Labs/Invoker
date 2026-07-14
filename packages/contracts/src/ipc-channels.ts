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

import type {
  TaskState,
  TaskDelta,
  TaskStateChanges,
  WorkflowDerivedStatus,
  WorkflowRollup,
} from '@invoker/workflow-graph';
import type { PrerequisiteCheck, PrerequisiteReport } from './prerequisites.js';

export type { WorkflowDerivedStatus, WorkflowRollup } from '@invoker/workflow-graph';
import type { ReviewGateQueryResponse } from './types.js';

// ── Types used by IPC channels ──────────────────────────────
// These were previously in packages/app/src/types.ts.
// Defined here so contracts stays independent of packages/app.

export interface TaskReplacementDef {
  id: string;
  description: string;
  command?: string;
  prompt?: string;
  dependencies?: string[];
  runnerKind?: string;
  executionAgent?: string;
}
export interface ExecutionModelOption {
  id: string;
  label: string;
}

export interface ExecutionHarnessOption {
  name: string;
  supportedModels: ExecutionModelOption[];
}

export interface ExecutionDefaults {
  executionAgent: string;
  executionModel?: string;
}


export interface WorkflowMeta {
  id: string;
  name: string;
  status: WorkflowDerivedStatus;
  rollup?: WorkflowRollup;
  baseBranch?: string;
  featureBranch?: string;
  onFinish?: string;
  mergeMode?: string;
  repoUrl?: string;
  intermediateRepoUrl?: string;
  createdAt?: string;
  updatedAt?: string;
}
export interface WorkflowRollupPatch {
  workflowId: string;
  status: WorkflowDerivedStatus;
  rollup: WorkflowRollup;
  /** True when the workflow no longer has any tasks (e.g. it was deleted); consumers must drop the workflow instead of patching it. */
  removed?: boolean;
}

export type TaskGraphEvent =
  | {
      type: 'delta';
      delta: TaskDelta;
      workflowRollups: WorkflowRollupPatch[];
    }
  | {
      type: 'snapshot';
      tasks: TaskState[];
      workflows: WorkflowMeta[];
      reason: string;
      streamSequence: number;
      forced?: boolean;
    };


export interface WorkflowStatus {
  total: number;
  completed: number;
  failed: number;
  closed: number;
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

export type AgentSessionState = 'running' | 'finished' | 'error';

export interface AgentSessionData {
  agentName: string;
  sessionId: string;
  state: AgentSessionState;
  messages: ClaudeMessage[];
  reason?: string;
  source?: 'local' | 'remote';
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

/** Max rows returned by a single `invoker:get-events` page. */
export const MAX_EVENTS_PAGE = 100;

/** Required pagination options for `invoker:get-events`. */
export interface GetEventsOptions {
  /** Default `'desc'` (newest first). */
  sortBy?: 'asc' | 'desc';
  /** Required page size; must be 1..MAX_EVENTS_PAGE. */
  limit: number;
  /** Optional cursor: return events with id strictly less than this (older). */
  beforeId?: number;
}

export interface NormalizedGetEventsOptions {
  sortBy: 'asc' | 'desc';
  limit: number;
  beforeId?: number;
}

/**
 * Validate and normalize get-events pagination options.
 * Rejects missing/invalid limit and pages larger than MAX_EVENTS_PAGE.
 */
export function normalizeGetEventsOptions(raw: unknown): NormalizedGetEventsOptions {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('getEvents requires options with a numeric limit');
  }
  const opts = raw as Record<string, unknown>;
  if (typeof opts.limit !== 'number' || !Number.isFinite(opts.limit)) {
    throw new Error('getEvents options.limit is required and must be a finite number');
  }
  const limit = Math.floor(opts.limit);
  if (limit <= 0 || limit > MAX_EVENTS_PAGE) {
    throw new Error(`getEvents options.limit must be between 1 and ${MAX_EVENTS_PAGE}`);
  }
  const sortBy = opts.sortBy === 'asc' ? 'asc' : 'desc';
  if (opts.beforeId === undefined) {
    return { sortBy, limit };
  }
  if (typeof opts.beforeId !== 'number' || !Number.isFinite(opts.beforeId)) {
    throw new Error('getEvents options.beforeId must be a finite number when provided');
  }
  return { sortBy, limit, beforeId: Math.floor(opts.beforeId) };
}

export interface TaskHistoryEntry extends TaskState {
  workflowName: string;
  lastEventAt: string | null;
  eventCount: number;
}

export interface QueueStatus {
  maxConcurrency: number;
  runningCount: number;
  activeExecutionCount?: number;
  launchingCount?: number;
  running: Array<{ taskId: string; description: string }>;
  queued: Array<{ taskId: string; priority: number; description: string }>;
}
export type WorkerLifecycleStatus = 'running' | 'stopped' | 'exited';
export type WorkerPolicyStatus = 'enabled' | 'disabled' | 'unknown';
export type WorkerControlAction = 'start' | 'stop';
export type WorkerActionStatus =
  | 'queued'
  | 'pending'
  | 'running'
  | 'needs_input'
  | 'review_ready'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'abandoned'
  | 'cancelled';

export interface WorkerActionSummary {
  id: string;
  workerKind: string;
  actionType: string;
  workflowId?: string;
  taskId?: string;
  subjectType: string;
  subjectId: string;
  externalKey: string;
  status: WorkerActionStatus;
  attemptCount: number;
  intentId?: string;
  agentName?: string;
  executionModel?: string;
  sessionId?: string;
  summary?: string;
  reason?: string;
  decision?: 'act' | 'skip';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkerRecoverySummary {
  workerId: string;
  owner: string;
  lastWakeupAt?: string;
  lastScanAt?: string;
  lastSubmitAt?: string;
  lastSkipAt?: string;
  lastSkipReason?: string;
  lastSkipTaskId?: string;
  wakeups: number;
  scans: number;
  submissions: number;
  skips: number;
}

export interface WorkerStatusEntry {
  kind: string;
  note: string;
  runtimeKind?: string;
  instanceId?: string;
  lifecycle: WorkerLifecycleStatus;
  policy: WorkerPolicyStatus;
  policyReason?: string;
  autoStarts: boolean;
  desiredEnabled?: boolean;
  startable: boolean;
  stoppable: boolean;
  controlDisabledReason?: string;
  startedAt?: string;
  stoppedAt?: string;
  lastError?: string;
  recentActions: WorkerActionSummary[];
  recovery?: WorkerRecoverySummary;
}

export interface WorkerStatusSnapshot {
  generatedAt: string;
  workers: WorkerStatusEntry[];
}

export interface WorkerActionHistoryRequest {
  workerKind: string;
  limit?: number;
  offset?: number;
}

export interface WorkerActionHistoryResponse {
  workerKind: string;
  actions: WorkerActionSummary[];
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
}
export interface WorkerDecisionsRequest {
  workflowId?: string;
  workerKind?: string;
  decision?: 'act' | 'skip';
  reason?: string;
  limit?: number;
  offset?: number;
}

export interface WorkerDecisionsResponse {
  workflowId?: string;
  actions: WorkerActionSummary[];
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset?: number;
}


export type UIActionGraphNodeType =
  | 'user-action'
  | 'mutation-intent'
  | 'mutation-lease'
  | 'launch-dispatch'
  | 'scheduler-job'
  | 'task-attempt'
  | 'blocker';

export type ActionGraphNodeStatus =
  | 'queued'
  | 'pending'
  | 'running'
  | 'waiting'
  | 'stalled'
  | 'failed'
  | 'cancelled'
  | 'completed';

export interface ActionGraphHistoryEntry {
  id: string;
  timestamp: string;
  source: string;
  message: string;
  level?: string;
}

export interface ActionGraphNodeDurations {
  queuedMs?: number;
  pendingMs?: number;
  runningMs?: number;
  waitingMs?: number;
  stalledMs?: number;
  heartbeatAgeMs?: number;
  leaseExpiresInMs?: number;
}

export interface ActionGraphNode {
  id: string;
  type: UIActionGraphNodeType;
  label: string;
  status: ActionGraphNodeStatus;
  workflowId?: string;
  taskId?: string;
  attemptId?: string;
  intentId?: number;
  priority?: number;
  ownerId?: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  latestError?: string;
  details?: Record<string, unknown>;
  durations?: ActionGraphNodeDurations;
  blockerIds?: string[];
  suggestedNextAction?: string;
  history?: ActionGraphHistoryEntry[];
}

export interface ActionGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface ActionGraphResponse {
  generatedAt: string;
  stallThresholdMs: number;
  nodes: ActionGraphNode[];
  edges: ActionGraphEdge[];
}

export interface ResumeWorkflowResult {
  workflow: { id: string; name: string; status: string };
  taskCount: number;
  startedCount: number;
}
export interface InAppPlanRequest {
  goal: string;
  presetKey?: string;
}

export type InAppPlanResponse =
  | {
      ok: true;
      planName: string;
      workflowId: string;
      workflowIds?: string[];
      workflowCount?: number;
    }
  | {
      ok: false;
      error: string;
    };

export interface PlanningPresetOption {
  key: string;
  label: string;
  tool: string;
  model?: string;
  isDefault: boolean;
}

export interface InAppPlanningPlanSummary {
  name: string;
  taskCount: number;
  workflowCount?: number;
  steps: string[];
}
export type InAppPlanningSessionStatus =
  | 'still_discussing'
  | 'waiting_for_answer'
  | 'draft_ready'
  | 'submitted';

export type PlanningTerminalMode = 'chat' | 'tmux';

export interface InAppPlanningChatLine {
  id: number;
  role: 'user' | 'assistant' | 'system';
  text: string;
  tone?: 'muted' | 'error' | 'success';
  createdAt: string;
}

export interface InAppPlanningSessionSummary {
  id: string;
  title: string;
  status: InAppPlanningSessionStatus;
  presetKey: string;
  messages: InAppPlanningChatLine[];
  draftPlanAvailable: boolean;
  draftPlanSummary?: InAppPlanningPlanSummary;
  submittedWorkflowId?: string;
  submittedPlanName?: string;
  terminalMode?: PlanningTerminalMode;
  terminalSessionId?: string;
  terminalStatus?: 'running' | 'exited';
  terminalExitCode?: number;
  terminalOutputSnapshot?: string;
  terminalUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InAppPlanningCreateSessionRequest {
  presetKey?: string;
  title?: string;
}

export type InAppPlanningCreateSessionResponse =
  | {
      ok: true;
      session: InAppPlanningSessionSummary;
    }
  | {
      ok: false;
      error: string;
    };

export type InAppPlanningListSessionsResponse = {
  ok: true;
  sessions: InAppPlanningSessionSummary[];
};


export interface InAppPlanningChatRequest {
  sessionId?: string;
  message: string;
  presetKey?: string;
}

export type InAppPlanningChatResponse =
  | {
      ok: true;
      sessionId: string;
      reply: string;
      draftPlanAvailable: boolean;
      draftPlanSummary?: InAppPlanningPlanSummary;
    }
  | {
      ok: false;
      sessionId?: string;
      error: string;
    };

export interface InAppPlanningSubmitRequest {
  sessionId: string;
}

export type InAppPlanningSubmitResponse =
  | {
      ok: true;
      planName: string;
      workflowId: string;
      workflowIds?: string[];
      workflowCount?: number;
    }
  | {
      ok: false;
      error: string;
    };

export interface InAppPlanningResetRequest {
  sessionId: string;
}

export type InAppPlanningResetResponse = { ok: true };

export interface InAppPlanningSetTerminalModeRequest {
  sessionId: string;
  mode: PlanningTerminalMode;
}

export type InAppPlanningSetTerminalModeResponse =
  | { ok: true }
  | { ok: false; error: string };



export interface WorkflowListEntry {
  id: string;
  name: string;
  status: WorkflowDerivedStatus;
  rollup?: WorkflowRollup;
  createdAt: string;
  updatedAt: string;
}

export interface RebaseAndRetryResult {
  success: boolean;
  rebasedBranches: string[];
  errors: string[];
}

export interface WorkflowMutationAcceptedResult {
  ok: true;
  accepted: true;
  intentId: number;
  workflowId: string;
  channel: string;
}

export interface StartReadyRequest {
  recreateFailed?: boolean;
  dryRun?: boolean;
}

export interface StartReadyPreview {
  readyTaskIds: string[];
  recoverableTaskIds: string[];
  failedWorkflowIds: string[];
  skipped: {
    awaitingApproval: number;
    reviewReady: number;
    blocked: number;
    failedTasks: number;
  };
}

export interface StartReadyResult {
  preview: StartReadyPreview;
  started: TaskState[];
  recreatedWorkflowIds: string[];
  dryRun: boolean;
}

export interface WorkflowMutationFailedEvent {
  intentId: number;
  workflowId: string;
  channel: string;
  taskId?: string;
  /** Present for headless.exec failures — the CLI subcommand (e.g. fix, approve). */
  headlessCommand?: string;
  message: string;
  failedAt: string;
}

export interface CancelResult {
  cancelled: string[];
  runningCancelled: string[];
}

export interface CleanupWorktreesResult {
  removed: string[];
  errors: string[];
}

export interface SystemToolStatus {
  id: string;
  name: string;
  required: boolean;
  installed: boolean;
  version?: string;
  installHint: string;
}

export interface BundledSkillTargetStatus {
  id: string;
  name: string;
  path: string;
  available: boolean;
  installed: boolean;
  upToDate: boolean;
  installedSkillNames: string[];
  missingSkillNames?: string[];
  staleReason?: 'not-installed' | 'manifest-missing' | 'manifest-target-missing' | 'target-path-changed' | 'bundle-updated' | 'manifest-skill-list-changed';
  diagnostic?: string;
}

export interface HarnessConfigState {
  id: string;
  name: string;
  path: string;
  available: boolean;
  installed: boolean;
  upToDate: boolean;
  installedCommandNames: string[];
}

export interface HarnessMcpConfigState {
  id: string;
  name: string;
  path: string;
  available: boolean;
  installed: boolean;
  upToDate: boolean;
  serverName: string;
}

export interface BundledSkillsStatus {
  available: boolean;
  promptRecommended: boolean;
  sourcePath?: string;
  managedPrefix: string;
  bundledSkillNames: string[];
  lastInstallAt?: string;
  lastInstallError?: string;
  targets: BundledSkillTargetStatus[];
  commandTargets: HarnessConfigState[];
  mcpTargets: HarnessMcpConfigState[];
}

export type BundledSkillsInstallMode = 'install' | 'update' | 'reinstall';

export interface CliInstallerStatus {
  /** Packaged app + bundled binary present + darwin/linux. */
  supported: boolean;
  bundledVersion: string;
  installedVersion?: string;
  installedPath?: string;
  upToDate: boolean;
  /** e.g. the chosen install dir is not on the user's PATH. */
  warning?: string;
  lastInstallError?: string;
}

export interface CliInstallResult {
  ok: boolean;
  updated: boolean;
  installedTo?: string;
  error?: string;
  status: CliInstallerStatus;
}
export interface InvokerSetupRequest {
  updateCli: boolean;
  installHelpers: boolean;
  fixTools: boolean;
  slack: false | {
    botToken: string;
    appToken: string;
    signingSecret: string;
    channelId: string;
  };
}

export interface InvokerSetupStepResult {
  id: 'invoker-cli' | 'helpers' | 'tools' | 'slack';
  name: string;
  ok: boolean;
  output: string;
  error?: string;
}

export interface InvokerSetupResult {
  ok: boolean;
  steps: InvokerSetupStepResult[];
}


export interface SystemDiagnostics {
  platform: string;
  arch: string;
  appVersion: string;
  isPackaged: boolean;
  tools: SystemToolStatus[];
  bundledSkills?: BundledSkillsStatus;
  cliInstaller?: CliInstallerStatus;
  readiness?: PrerequisiteReport | PrerequisiteCheck[];
}

export type RuntimeMode = 'local-owner' | 'daemon-owner' | 'read-only' | 'connection-lost';

export interface RuntimeStatus {
  ownerMode: boolean;
  readOnly: boolean;
  mode: RuntimeMode;
}


// ── Embedded terminal session types ─────────────────────────

/**
 * Describes an embedded terminal session managed by the main process.
 *
 * `mode` distinguishes how the session is backed:
 *   - `spawn`    — main process spawned a fresh child shell for the task
 *                  (typical for completed/failed tasks restoring a workspace).
 *   - `attached` — the session is wired to a live executor handle; output is
 *                  fanned in from `executor.onOutput` and input flows through
 *                  `executor.sendInput` (used for tasks still running).
 */
export interface TerminalSessionDescriptor {
  sessionId: string;
  taskId: string;
  kind?: 'task' | 'planning';
  planningSessionId?: string;
  status: 'running' | 'exited';
  exitCode?: number;
  cwd?: string;
  command?: string;
  args?: string[];
  mode: 'spawn' | 'attached';
  attached: boolean;
  createdAt: string;
  /** Bounded recent terminal output snapshot used to seed newly mounted panes. */
  outputSnapshot?: string;
}

export interface TerminalOutputEvent {
  sessionId: string;
  taskId: string;
  kind?: 'task' | 'planning';
  planningSessionId?: string;
  data: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  taskId: string;
  kind?: 'task' | 'planning';
  planningSessionId?: string;
  exitCode?: number;
}

export interface OpenTerminalResponse {
  opened: boolean;
  reason?: string;
  /** Present when the GUI main process opened an embedded session. */
  session?: TerminalSessionDescriptor;
}

// ── Search types ────────────────────────────────────────────

export interface SearchResultItem {
  kind: 'workflow' | 'task';
  id: string;
  workflowId?: string;      // populated for task results
  title: string;            // workflow name or task description
  subtitle: string;         // "Workflow · <status>" or "Task · <workflowName>"
  status: string;
  createdAt: string;
}

export interface SearchOptions {
  type?: 'workflows' | 'tasks' | 'all';
  limit?: number;
  offset?: number;
}

// ── Invoke Channel Registry ─────────────────────────────────
// Each key is the channel name string; value is { request, response }.
// `request` is a tuple of the arguments passed after the channel name.

export const IpcChannels = {
  // Plan & Workflow Management
  'invoker:plan-from-goal': {} as {
    request: [request: InAppPlanRequest];
    response: InAppPlanResponse;
  },
  'invoker:planning-chat-create': {} as {
    request: [request?: InAppPlanningCreateSessionRequest];
    response: InAppPlanningCreateSessionResponse;
  },
  'invoker:planning-chat-list': {} as {
    request: [];
    response: InAppPlanningListSessionsResponse;
  },
  'invoker:planning-chat-send': {} as {
    request: [request: InAppPlanningChatRequest];
    response: InAppPlanningChatResponse;
  },
  'invoker:planning-chat-submit': {} as {
    request: [request: InAppPlanningSubmitRequest];
    response: InAppPlanningSubmitResponse;
  },
  'invoker:planning-chat-reset': {} as {
    request: [request: InAppPlanningResetRequest];
    response: InAppPlanningResetResponse;
  },
  'invoker:planning-chat-set-terminal-mode': {} as {
    request: [request: InAppPlanningSetTerminalModeRequest];
    response: InAppPlanningSetTerminalModeResponse;
  },
  'invoker:planning-terminal-open': {} as {
    request: [planningSessionId: string];
    response: OpenTerminalResponse;
  },
  'invoker:planning-terminal-list': {} as {
    request: [];
    response: TerminalSessionDescriptor[];
  },
  'invoker:planning-terminal-write': {} as {
    request: [sessionId: string, data: string];
    response: { ok: boolean; reason?: string };
  },
  'invoker:planning-terminal-resize': {} as {
    request: [sessionId: string, cols: number, rows: number];
    response: { ok: boolean; reason?: string };
  },
  'invoker:planning-terminal-close': {} as {
    request: [sessionId: string];
    response: { ok: boolean; reason?: string };
  },
  'invoker:get-planning-presets': {} as {
    request: [];
    response: PlanningPresetOption[];
  },
  'invoker:load-plan': {} as {
    request: [planText: string];
    response: void;
  },
  'invoker:start': {} as {
    request: [];
    response: TaskState[];
  },
  'invoker:start-ready': {} as {
    request: [request?: StartReadyRequest];
    response: StartReadyResult;
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
  'invoker:delete-all-workflows-bulk': {} as {
    request: [];
    response: void;
  },
  'invoker:delete-workflow': {} as {
    request: [workflowId: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:detach-workflow': {} as {
    request: [workflowId: string, upstreamWorkflowId: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:load-workflow': {} as {
    request: [workflowId: string];
    response: { workflow: unknown; tasks: unknown[] };
  },

  // Task Queries
  'invoker:get-tasks': {} as {
    request: [];
    response: { tasks: TaskState[]; workflows: WorkflowMeta[]; streamSequence: number };
  },
  'invoker:refresh-task-graph': {} as {
    request: [];
    response: void;
  },
  'invoker:get-events': {} as {
    request: [taskId: string, options?: GetEventsOptions];
    response: TaskEvent[];
  },
  'invoker:get-status': {} as {
    request: [];
    response: WorkflowStatus;
  },
  'invoker:get-task-by-id': {} as {
    request: [taskId: string];
    response: TaskState | null;
  },
  'invoker:get-task-output': {} as {
    request: [taskId: string];
    response: string;
  },
  'invoker:get-all-completed-tasks': {} as {
    request: [];
    response: Array<TaskState & { workflowName: string }>;
  },
  'invoker:get-history-tasks': {} as {
    request: [];
    response: TaskHistoryEntry[];
  },

  // Task Actions
  'invoker:provide-input': {} as {
    request: [taskId: string, input: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:approve': {} as {
    request: [taskId: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:reject': {} as {
    request: [taskId: string, reason?: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:select-experiment': {} as {
    request: [taskId: string, experimentId: string | string[]];
    response: WorkflowMutationAcceptedResult;
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
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:cancel-task': {} as {
    request: [taskId: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:delete-task': {} as {
    request: [taskId: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:cancel-workflow': {} as {
    request: [workflowId: string];
    response: WorkflowMutationAcceptedResult;
  },

  // Task Editing
  'invoker:edit-task-command': {} as {
    request: [taskId: string, newCommand: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:edit-task-pool': {} as {
    request: [taskId: string, poolId: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:edit-task-type': {} as {
    request: [taskId: string, runnerKind: string, poolMemberId?: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:edit-task-agent': {} as {
    request: [taskId: string, agentName: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:edit-task-model': {} as {
    request: [taskId: string, executionModel: string | null];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:edit-task-prompt': {} as {
    request: [taskId: string, newPrompt: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:set-task-external-gate-policies': {} as {
    request: [taskId: string, updates: ExternalGatePolicyUpdate[]];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:replace-task': {} as {
    request: [taskId: string, replacementTasks: TaskReplacementDef[]];
    response: WorkflowMutationAcceptedResult;
  },

  // Session & Agent Access
  'invoker:get-claude-session': {} as {
    request: [sessionId: string];
    response: AgentSessionData | null;
  },
  'invoker:get-agent-session': {} as {
    request: [sessionId: string, agentName?: string];
    response: AgentSessionData | null;
  },

  // Workflow Mutation & Merge
  'invoker:recreate-workflow': {} as {
    request: [workflowId: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:recreate-task': {} as {
    request: [taskId: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:recreate-downstream': {} as {
    request: [taskId: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:retry-workflow': {} as {
    request: [workflowId: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:rebase-retry': {} as {
    request: [target: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:rebase-recreate': {} as {
    request: [target: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:set-merge-branch': {} as {
    request: [workflowId: string, baseBranch: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:set-merge-mode': {} as {
    request: [workflowId: string, mergeMode: string];
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:approve-merge': {} as {
    request: [workflowId: string];
    response: WorkflowMutationAcceptedResult;
  },

  'invoker:get-review-gate': {} as {
    request: [workflowId: string];
    response: ReviewGateQueryResponse | null;
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
    response: WorkflowMutationAcceptedResult;
  },
  'invoker:fix-with-agent': {} as {
    request: [taskId: string, agentName?: string];
    response: WorkflowMutationAcceptedResult;
  },

  // Queue & Configuration
  'invoker:get-queue-status': {} as {
    request: [];
    response: QueueStatus;
  },
  'invoker:get-worker-status': {} as {
    request: [];
    response: WorkerStatusSnapshot;
  },
  'invoker:get-worker-action-history': {} as {
    request: [request: WorkerActionHistoryRequest];
    response: WorkerActionHistoryResponse;
  },
  'invoker:get-worker-decisions': {} as {
    request: [request: WorkerDecisionsRequest];
    response: WorkerDecisionsResponse;
  },
  'invoker:start-worker': {} as {
    request: [kind: string];
    response: WorkerStatusEntry;
  },
  'invoker:stop-worker': {} as {
    request: [kind: string];
    response: WorkerStatusEntry;
  },
  'invoker:get-action-graph': {} as {
    request: [];
    response: ActionGraphResponse;
  },
  'invoker:get-remote-targets': {} as {
    request: [];
    response: string[];
  },
  'invoker:get-execution-pools': {} as {
    request: [];
    response: string[];
  },
  'invoker:get-execution-harnesses': {} as {
    request: [];
    response: ExecutionHarnessOption[];
  },
  'invoker:get-execution-defaults': {} as {
    request: [];
    response: ExecutionDefaults;
  },

  'invoker:get-runtime-status': {} as {
    request: [];
    response: RuntimeStatus;
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
    request: [sinceId?: number, limit?: number];
    response: ActivityLogEntry[];
  },

  // Terminal
  'invoker:open-terminal': {} as {
    request: [taskId: string];
    response: OpenTerminalResponse;
  },
  'invoker:terminal-list': {} as {
    request: [];
    response: TerminalSessionDescriptor[];
  },
  'invoker:terminal-write': {} as {
    request: [sessionId: string, data: string];
    response: { ok: boolean; reason?: string };
  },
  'invoker:terminal-resize': {} as {
    request: [sessionId: string, cols: number, rows: number];
    response: { ok: boolean; reason?: string };
  },
  'invoker:terminal-close': {} as {
    request: [sessionId: string];
    response: { ok: boolean; reason?: string };
  },

  // Worktree Cleanup
  'invoker:cleanup-worktrees': {} as {
    request: [];
    response: CleanupWorktreesResult;
  },
  'invoker:get-system-diagnostics': {} as {
    request: [];
    response: SystemDiagnostics;
  },
  'invoker:get-bundled-skills-status': {} as {
    request: [];
    response: BundledSkillsStatus;
  },
  'invoker:search': {} as {
    request: [query: string, options?: SearchOptions];
    response: SearchResultItem[];
  },
  'invoker:install-bundled-skills': {} as {
    request: [mode?: BundledSkillsInstallMode];
    response: BundledSkillsStatus;
  },
  'invoker:update-invoker-cli': {} as {
    request: [];
    response: CliInstallResult;
  },
  'invoker:run-invoker-cli-setup': {} as {
    request: [request: InvokerSetupRequest];
    response: InvokerSetupResult;
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
  'invoker:set-test-plan-from-goal-response': {} as {
    request: [response: { planYaml: string; planName: string } | null];
    response: void;
  },
  'invoker:set-test-planning-chat-response': {} as {
    request: [
      response:
        | { planYaml: string; planName: string; reply?: string }
        | { throwError: string }
        | null,
    ];
    response: void;
  },
  'invoker:seed-main-process-hitch-fixture': {} as {
    request: [];
    response: {
      workflowId: string;
      taskCount: number;
      eventCount: number;
      workerActionCount: number;
    };
  },
  'invoker:seed-stress-fixture': {} as {
    request: [options?: {
      workflowCount?: number;
      tasksPerWorkflow?: number;
      eventsPerTask?: number;
      nowIso?: string;
      stuckLaunchingSlots?: number;
      launchAgeMs?: number;
    }];
    response: {
      workflowCount: number;
      taskCount: number;
      running: number;
      launching: number;
      fixing: number;
      pending: number;
      failed: number;
    };
  },
} as const;

// ── Event Channel Registry ──────────────────────────────────
// Pushed from main → renderer via webContents.send.

export const IpcEventChannels = {
  'invoker:task-graph-event': {} as {
    payload: TaskGraphEvent;
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
  'invoker:terminal-output': {} as {
    payload: TerminalOutputEvent;
  },
  'invoker:terminal-exit': {} as {
    payload: TerminalExitEvent;
  },
  'invoker:workflow-mutation-failed': {} as {
    payload: WorkflowMutationFailedEvent;
  },
  'invoker:runtime-status': {} as {
    payload: RuntimeStatus;
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

/** Convert an IPC channel name to its API method name. e.g. 'invoker:get-tasks' → 'getTasks'. */
export function channelToMethod(channel: string): string {
  const stripped = channel.startsWith('invoker:') ? channel.slice(8) : channel;
  return stripped.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Convert an event channel name to its `on*` subscription method. e.g. 'invoker:task-graph-event' → 'onTaskGraphEvent'. */
export function channelToEventMethod(channel: string): string {
  const base = channelToMethod(channel);
  return `on${base.charAt(0).toUpperCase()}${base.slice(1)}`;
}

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
