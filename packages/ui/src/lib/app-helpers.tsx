/**
 * Module-scope helpers extracted from App.tsx to keep it under the
 * repo's large-file guardrail (scripts/check-large-files.mjs).
 */

import { toast } from 'sonner';
import type {
  InAppPlanningSessionStatus,
  InAppPlanningSessionSummary,
  PlanningConfirmationMode,
  StartReadyFreshBaseScope,
  StartReadyRequest,
  StartReadyResult,
  TerminalOutputEvent,
  TerminalSessionDescriptor,
} from '@invoker/contracts';
import type { TaskState, WorkflowMeta, WorkerActionSummary, WorkerLogEntry, WorkerStatusEntry } from '../types.js';
import type { InvokerTerminalLine, PlanningTerminalMode } from '../components/InvokerTerminal.js';
import type { TerminalDrawerState } from '../components/TerminalDrawer.js';
import { displayWorkerTaskId, formatWorkerValue, getActiveWorkerAction } from './worker-display.js';

const SIDEBAR_NAV_ITEM_SELECTOR = '[data-sidebar-nav-item]';
const EDITABLE_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '.xterm',
  '[role="dialog"] input',
  '[role="dialog"] textarea',
].join(',');
const PLANNING_TERMINAL_OUTPUT_SNAPSHOT_CHARS = 64 * 1024;

export function appendPlanningTerminalSnapshot(snapshot: string | undefined, data: string): string {
  const next = `${snapshot ?? ''}${data}`;
  if (next.length <= PLANNING_TERMINAL_OUTPUT_SNAPSHOT_CHARS) return next;
  return next.slice(next.length - PLANNING_TERMINAL_OUTPUT_SNAPSHOT_CHARS);
}

export function planningTerminalSessionFromOutputEvent(
  session: PlanningSessionView,
  event: TerminalOutputEvent,
  outputSnapshot: string,
): TerminalSessionDescriptor {
  return {
    sessionId: session.terminalSession?.sessionId ?? session.terminalSessionId ?? event.sessionId,
    taskId: session.terminalSession?.taskId ?? event.taskId,
    kind: 'planning',
    planningSessionId: session.id,
    status: session.terminalSession?.status ?? session.terminalStatus ?? 'running',
    exitCode: session.terminalSession?.exitCode ?? session.terminalExitCode,
    cwd: session.terminalSession?.cwd,
    command: session.terminalSession?.command,
    args: session.terminalSession?.args,
    mode: session.terminalSession?.mode ?? 'spawn',
    attached: session.terminalSession?.attached ?? false,
    createdAt: session.terminalSession?.createdAt ?? session.terminalUpdatedAt ?? session.updatedAt,
    outputSnapshot,
  };
}

export function notifyMutationError(rawTitle: string, err: unknown): void {
  console.error(rawTitle, err);
  const title = rawTitle.replace(/[:\s]+$/, '');
  const description = err instanceof Error ? err.message : typeof err === 'string' ? err : undefined;
  toast.error(title, description ? { description } : undefined);
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export type StartReadyRailModeId =
  | 'recreateFailed'
  | 'recreateFailedAndPending'
  | 'recreateFailedPendingAndRunning'
  | 'freshBaseFailed'
  | 'freshBaseFailedAndPending'
  | 'freshBaseFailedPendingAndRunning';

export type StartReadyRailMode = {
  id: StartReadyRailModeId;
  kind: 'recreate' | 'freshBase';
  testId: string;
  label: string;
  title: string;
  confirmLabel: string;
  request: StartReadyRequest;
  includesPending: boolean;
  includesRunning: boolean;
  freshBaseScope?: StartReadyFreshBaseScope;
};

export const START_READY_RAIL_MODES: readonly StartReadyRailMode[] = [
  {
    id: 'recreateFailed',
    kind: 'recreate',
    testId: 'rail-start-ready-recreate-failed',
    label: 'Start and recreate failed…',
    title: 'Start and recreate failed',
    confirmLabel: 'Start and recreate',
    request: { recreateFailed: true },
    includesPending: false,
    includesRunning: false,
  },
  {
    id: 'recreateFailedAndPending',
    kind: 'recreate',
    testId: 'rail-start-ready-recreate-failed-and-pending',
    label: 'Start and recreate failed and pending…',
    title: 'Start and recreate failed and pending',
    confirmLabel: 'Start and recreate',
    request: { recreateFailedAndPending: true },
    includesPending: true,
    includesRunning: false,
  },
  {
    id: 'recreateFailedPendingAndRunning',
    kind: 'recreate',
    testId: 'rail-start-ready-recreate-failed-pending-and-running',
    label: 'Start and recreate failed, pending, and running…',
    title: 'Start and recreate failed, pending, and running',
    confirmLabel: 'Start and recreate',
    request: { recreateFailedPendingAndRunning: true },
    includesPending: true,
    includesRunning: true,
  },
  {
    id: 'freshBaseFailed',
    kind: 'freshBase',
    testId: 'rail-start-ready-fresh-base-failed',
    label: 'Recreate failed from fresh base…',
    title: 'Start and recreate failed from fresh base',
    confirmLabel: 'Start and recreate from fresh base',
    request: { freshBaseScope: 'failed' },
    includesPending: false,
    includesRunning: false,
    freshBaseScope: 'failed',
  },
  {
    id: 'freshBaseFailedAndPending',
    kind: 'freshBase',
    testId: 'rail-start-ready-fresh-base-failed-and-pending',
    label: 'Recreate failed and pending from fresh base…',
    title: 'Start and recreate failed and pending from fresh base',
    confirmLabel: 'Start and recreate from fresh base',
    request: { freshBaseScope: 'failed-and-pending' },
    includesPending: true,
    includesRunning: false,
    freshBaseScope: 'failed-and-pending',
  },
  {
    id: 'freshBaseFailedPendingAndRunning',
    kind: 'freshBase',
    testId: 'rail-start-ready-fresh-base-failed-pending-and-running',
    label: 'Recreate failed, pending, and running from fresh base…',
    title: 'Start and recreate failed, pending, and running from fresh base',
    confirmLabel: 'Start and recreate from fresh base',
    request: { freshBaseScope: 'failed-pending-and-running' },
    includesPending: true,
    includesRunning: true,
    freshBaseScope: 'failed-pending-and-running',
  },
];

const START_READY_RAIL_MODE_BY_ID = new Map(
  START_READY_RAIL_MODES.map((mode) => [mode.id, mode]),
);

export function getStartReadyRailMode(id: StartReadyRailModeId): StartReadyRailMode {
  return START_READY_RAIL_MODE_BY_ID.get(id) ?? START_READY_RAIL_MODES[0];
}

export function startReadyRequestForMode(mode: StartReadyRailMode, dryRun = false): StartReadyRequest {
  return dryRun ? { dryRun: true, ...mode.request } : { ...mode.request };
}

export function isPendingOrQueuedStatus(status: TaskState['status']): boolean {
  return status === 'pending' || (status as string) === 'queued';
}

export function freshBaseModeHasVisibleTargets(
  mode: StartReadyRailMode,
  targetCounts: { failed: number; pending: number; running: number },
): boolean {
  if (mode.kind !== 'freshBase') return true;
  switch (mode.freshBaseScope) {
    case 'failed':
      return targetCounts.failed > 0;
    case 'failed-and-pending':
      return targetCounts.pending > 0;
    case 'failed-pending-and-running':
      return targetCounts.running > 0;
    default:
      return false;
  }
}

export function startReadyPreviewRows(mode: StartReadyRailMode, result: StartReadyResult): Array<[string, number]> {
  const rows: Array<[string, number]> = [
    ['Ready tasks', result.preview.readyTaskIds.length],
    ['Recoverable tasks', result.preview.recoverableTaskIds.length],
    ['Failed workflows', result.preview.failedWorkflowIds.length],
  ];

  if (mode.includesPending) {
    rows.push(
      ['Pending workflows', result.preview.pendingWorkflowIds.length],
      ['Pending tasks', result.preview.skipped.pendingTasks],
    );
  }
  if (mode.includesRunning) {
    rows.push(
      ['Running workflows', result.preview.runningWorkflowIds.length],
      ['Running tasks', result.preview.skipped.runningTasks],
    );
  }
  if (mode.kind === 'freshBase' && result.preview.freshBase) {
    rows.push(
      ['Fresh-base workflows', result.preview.freshBase.workflowIds.length],
      ['Fresh-base failed workflows', result.preview.freshBase.failedWorkflowIds.length],
    );
    if (mode.includesPending) {
      rows.push(['Fresh-base pending workflows', result.preview.freshBase.pendingWorkflowIds.length]);
    }
    if (mode.includesRunning) {
      rows.push(['Fresh-base running workflows', result.preview.freshBase.runningWorkflowIds.length]);
    }
  }

  rows.push(
    ['Awaiting approval', result.preview.skipped.awaitingApproval],
    ['Review ready', result.preview.skipped.reviewReady],
    ['Blocked', result.preview.skipped.blocked],
  );
  return rows;
}

export type PlanningSessionView = Omit<InAppPlanningSessionSummary, 'messages'> & {
  messages: InvokerTerminalLine[];
  input: string;
  busy: boolean;
  conversationKey: string;
  mode: PlanningTerminalMode;
  terminalSession?: TerminalSessionDescriptor | null;
  terminalBusy?: boolean;
  terminalError?: string | null;
  repoInput?: string;
  repoError?: string | null;
};

export function planningSessionFromSummary(
  summary: InAppPlanningSessionSummary,
  overrides: Partial<PlanningSessionView> = {},
): PlanningSessionView {
  const restoredTerminalSession = summary.terminalSessionId
    && (summary.terminalStatus === 'running' || summary.terminalStatus === 'exited')
    ? {
        sessionId: summary.terminalSessionId,
        taskId: `planning:${summary.id}`,
        kind: 'planning' as const,
        planningSessionId: summary.id,
        status: summary.terminalStatus,
        exitCode: summary.terminalExitCode,
        cwd: undefined,
        mode: 'spawn' as const,
        attached: false,
        createdAt: summary.terminalUpdatedAt ?? summary.updatedAt,
        outputSnapshot: summary.terminalOutputSnapshot ?? '',
      }
    : null;
  return {
    ...summary,
    messages: summary.messages.map((line) => ({
      id: line.id,
      text: line.text,
      role: line.role,
      tone: line.tone,
    })),
    input: '',
    busy: false,
    conversationKey: summary.id,
    mode: summary.terminalMode ?? 'chat',
    terminalSession: restoredTerminalSession,
    terminalBusy: false,
    terminalError: null,
    ...overrides,
  };
}

export type PlanningStreamState = {
  text: string;
  status: 'streaming' | 'failed';
};

export function makeInitialPlanningSession(
  now: string = new Date().toISOString(),
  confirmationMode: PlanningConfirmationMode = 'require',
): PlanningSessionView {
  return {
    id: 'local-planning-session-1',
    title: 'Untitled plan',
    status: 'still_discussing',
    presetKey: '',
    confirmationMode,
    messages: [],
    input: '',
    draftPlanAvailable: false,
    busy: false,
    createdAt: now,
    updatedAt: now,
    conversationKey: 'local-planning-session-1',
    mode: 'chat',
    terminalSession: null,
    terminalBusy: false,
    terminalError: null,
  };
}

export function isInitialPlanningSessionPlaceholder(session: PlanningSessionView | undefined): boolean {
  if (!session) return false;
  return session.id === 'local-planning-session-1'
    && session.title === 'Untitled plan'
    && session.input === ''
    && !session.busy
    && session.messages.length === 0
    && !session.draftPlanAvailable
    && !session.terminalSession
    && !session.terminalBusy
    && !session.terminalError;
}

export function reconcileHydratedPlanningSessions(
  currentSessions: PlanningSessionView[],
  restoredSessions: PlanningSessionView[],
): PlanningSessionView[] {
  if (restoredSessions.length === 0) return currentSessions;
  if (
    currentSessions.length === 0
    || (currentSessions.length === 1 && isInitialPlanningSessionPlaceholder(currentSessions[0]))
  ) {
    return restoredSessions;
  }

  const restoredById = new Map(restoredSessions.map((session) => [session.id, session]));
  const currentIds = new Set(currentSessions.map((session) => session.id));
  const mergedCurrentSessions = currentSessions.map((session) => {
    const restored = restoredById.get(session.id);
    if (!restored) return session;
    return {
      ...restored,
      input: session.input,
      busy: session.busy,
      conversationKey: session.conversationKey,
      mode: session.mode === 'tmux' || restored.mode === 'tmux' ? 'tmux' : restored.mode,
      terminalSession: restored.terminalSession ?? session.terminalSession,
      terminalBusy: restored.terminalSession ? false : session.terminalBusy,
      terminalError: restored.terminalSession ? null : session.terminalError,
      repoInput: session.repoInput,
      repoError: session.repoError,
    };
  });
  const newRestoredSessions = restoredSessions.filter((session) => !currentIds.has(session.id));
  return [...mergedCurrentSessions, ...newRestoredSessions];
}

export function planningSessionSummaryToView(session: InAppPlanningSessionSummary): PlanningSessionView {
  return planningSessionFromSummary(session);
}

export function planningNeedsAttention(status: InAppPlanningSessionStatus): boolean {
  return status === 'waiting_for_answer' || status === 'draft_ready';
}

export function planningRepoLabel(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\.git$/, '');
  const segments = trimmed.split(/[/:]/).filter(Boolean);
  return segments.length >= 2 ? segments.slice(-2).join('/') : (segments.at(-1) ?? trimmed);
}

export function planningRepoStatusText(repoUrl: string | undefined, baseCommit: string | undefined): string {
  if (!repoUrl) return 'No repository bound yet';
  const label = planningRepoLabel(repoUrl);
  return baseCommit ? `${label} @ ${baseCommit.slice(0, 7)}` : label;
}

export function previewPlanningMessage(session: PlanningSessionView): string {
  const last = [...session.messages].reverse().find((line) => line.role !== 'system') ?? session.messages.at(-1);
  return last?.text.replace(/\s+/g, ' ').trim() || 'No messages yet';
}

export function planningSessionStatusLabel(session: PlanningSessionView): string {
  if (session.busy) return 'Working';
  if (session.status === 'draft_ready') return 'Draft ready';
  if (session.status === 'waiting_for_answer') return 'Waiting for answer';
  if (session.status === 'submitted') return 'Submitted';
  return 'Still discussing';
}

export function relativePlanningUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'now';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}

const PLANNING_TYPING_LAG_METRIC = 'planning_typing_lag_baseline';
const PLANNING_TYPING_SCENARIO = 'many-chats-many-messages-typing';

export { PLANNING_TYPING_LAG_METRIC };

export interface PlanningTypingTelemetryState {
  tasks: Map<string, TaskState>;
  workflows: Map<string, WorkflowMeta>;
  viewMode: 'dag' | 'history' | 'timeline' | 'queue' | 'actionGraph';
  terminalDrawerState: TerminalDrawerState;
  selectedTaskId: string | null;
  selectedWorkflowId: string | null;
  hasLoadedPlan: boolean;
}

function utf8Size(value: string): number {
  if (typeof Blob !== 'undefined') {
    return new Blob([value]).size;
  }
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }
  return value.length;
}

function transcriptPartsForTask(task: TaskState): string[] {
  return [
    task.config.prompt,
    task.config.experimentPrompt,
    task.config.summary,
    task.config.problem,
    task.config.approach,
    task.config.testPlan,
    task.execution.inputPrompt,
    task.execution.pendingFixError,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function transcriptMessageCount(value: string): number {
  return value.split(/\n+/).filter((line) => line.trim().length > 0).length;
}

function sessionIdsForTask(task: TaskState): string[] {
  return [
    task.execution.agentSessionId,
    task.execution.lastAgentSessionId,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function selectionState(selectedTaskId: string | null, selectedWorkflowId: string | null): string {
  if (selectedTaskId) return 'task_selected';
  if (selectedWorkflowId) return 'workflow_selected';
  return 'none';
}

export function createPlanningTypingTelemetryContext({
  tasks,
  workflows,
  viewMode,
  terminalDrawerState,
  selectedTaskId,
  selectedWorkflowId,
  hasLoadedPlan,
}: PlanningTypingTelemetryState): Record<string, unknown> {
  const sessions = new Set<string>();
  const taskStatusCounts: Record<string, number> = {};
  let transcriptSizeBytes = 0;
  let transcriptLineCount = 0;

  for (const task of tasks.values()) {
    taskStatusCounts[task.status] = (taskStatusCounts[task.status] ?? 0) + 1;
    for (const sessionId of sessionIdsForTask(task)) {
      sessions.add(sessionId);
    }
    for (const part of transcriptPartsForTask(task)) {
      transcriptSizeBytes += utf8Size(part);
      transcriptLineCount += transcriptMessageCount(part);
    }
  }

  const activeSelectionState = selectionState(selectedTaskId, selectedWorkflowId);

  return {
    scenario: PLANNING_TYPING_SCENARIO,
    sessionCount: sessions.size,
    transcriptSizeBytes,
    transcriptMessageCount: transcriptLineCount,
    taskCount: tasks.size,
    workflowCount: workflows.size,
    taskStatusCounts,
    activeSurface: viewMode === 'dag' ? 'planning' : viewMode,
    activeState: `${viewMode}:${activeSelectionState}:terminal-${terminalDrawerState}`,
    viewMode,
    terminalDrawerState,
    selectionState: activeSelectionState,
    selectedTaskId,
    selectedWorkflowId,
    hasLoadedPlan,
  };
}

export function isTextInputElement(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return [
    'email',
    'number',
    'password',
    'search',
    'tel',
    'text',
    'url',
  ].includes(target.type);
}

export function PlanningSessionStatusIcon({
  busy,
  status,
  workflowRunning,
}: {
  busy: boolean;
  status: InAppPlanningSessionStatus;
  workflowRunning: boolean;
}): JSX.Element {
  if (busy) {
    return (
      <span
        className="mt-1 inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-muted-foreground border-t-foreground"
        aria-label="Running"
      />
    );
  }
  if (planningNeedsAttention(status)) {
    return (
      <span
        className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-foreground"
        aria-label="Needs attention"
      />
    );
  }
  if (status === 'submitted' && workflowRunning) {
    return (
      <span
        className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary"
        aria-label="Workflow running"
      />
    );
  }
  return <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0" aria-hidden="true" />;
}

function sidebarNavOrder(item: HTMLElement): number {
  const order = Number(item.dataset.sidebarNavOrder);
  return Number.isFinite(order) ? order : Number.POSITIVE_INFINITY;
}

export function getOrderedSidebarNavItems(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(SIDEBAR_NAV_ITEM_SELECTOR)].sort((a, b) => {
    const aOrder = sidebarNavOrder(a);
    const bOrder = sidebarNavOrder(b);
    if (aOrder !== bOrder) return aOrder < bOrder ? -1 : 1;
    if (a === b) return 0;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(EDITABLE_SELECTOR));
}

export function normalizedSearchText(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

export function workerActionTarget(action: WorkerActionSummary): string {
  if (action.taskId) return `Task: ${displayWorkerTaskId(action.taskId)}`;
  return `${formatWorkerValue(action.subjectType)}: ${action.subjectId}`;
}

export function workerLogTarget(log: WorkerLogEntry): string {
  if (log.taskId) return `Task: ${displayWorkerTaskId(log.taskId)}`;
  if (log.subjectType && log.subjectId) return `${formatWorkerValue(log.subjectType)}: ${log.subjectId}`;
  if (log.workflowId) return `Workflow: ${log.workflowId}`;
  return 'No target';
}

export function workerStateLabel(worker: WorkerStatusEntry): string {
  const activeAction = getActiveWorkerAction(worker);
  if (activeAction) return `${formatWorkerValue(worker.lifecycle)} · ${formatWorkerValue(activeAction.status)}`;
  return formatWorkerValue(worker.lifecycle);
}

export function workerLogTitle(log: WorkerLogEntry): string {
  return formatWorkerValue(log.eventType ?? log.actionType ?? log.source);
}
