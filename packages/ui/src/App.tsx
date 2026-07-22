/**
 * App — Main layout for Invoker UI.
 *
 * Layout:
 * - Left: run/status column
 * - Main: terminal and graph
 * - Right: empty-state tutorial or inspector
 * - Bottom: status chips and terminal drawer
 * - Modals overlay when needed
 */

import { useState, useCallback, useMemo, useEffect, useRef, useLayoutEffect, type RefObject } from 'react';
import yaml from 'js-yaml';
import type { ActionGraphNode, ExecutionDefaults, ExecutionHarnessOption, InAppPlanningSessionStatus, InAppPlanningSessionSummary, InvokerSetupRequest, InvokerSetupResult, ReviewGateQueryResponse, RuntimeStatus, StartReadyRequest, StartReadyResult, TerminalSessionDescriptor, WorkflowMutationFailedEvent } from '@invoker/contracts';
import type { TaskState, TaskReplacementDef, ExternalGatePolicyUpdate, WorkflowMeta, WorkflowStatus, WorkerActionSummary, WorkerLogEntry, WorkerStatusEntry } from './types.js';
import type { SidebarSurface } from './lib/workflow-progress-surfaces.js';
import { reportUiNavigation } from './lib/report-ui-navigation.js';

import { useTasks } from './hooks/useTasks.js';
import { useQueueStatus } from './hooks/useQueueStatus.js';
import { useWorkerStatus } from './hooks/useWorkerStatus.js';
import { useActionGraphSnapshot } from './hooks/useActionGraphSnapshot.js';
import { useInvoker } from './hooks/useInvoker.js';
import { TaskDAG } from './components/TaskDAG.js';
import { HistoryView } from './components/HistoryView.js';
import { TimelineView } from './components/TimelineView.js';
import { ApprovalModal } from './components/ApprovalModal.js';
import { InputModal } from './components/InputModal.js';
import { ExperimentModal } from './components/ExperimentModal.js';
import { ContextMenu } from './components/ContextMenu.js';
import { QueueView } from './components/QueueView.js';
import { ReplaceTaskModal } from './components/ReplaceTaskModal.js';
import { SystemSetupModal } from './components/SystemSetupModal.js';
import { WorkflowGraph } from './components/WorkflowGraph.js';
import { FloatingGraphPanel } from './components/FloatingGraphPanel.js';
import { WorkflowInspector } from './components/WorkflowInspector.js';
import { WorkerDetailsPanel } from './components/WorkerDetailsPanel.js';
import { WorkerDetailControl } from './components/WorkerDetailControl.js';
import { WorkerActivityCard } from './components/WorkerActivityCard.js';
import { groupWorkflowCoreActivity } from './lib/workflow-core-activity.js';
import { ActionGraphView } from './components/ActionGraphView.js';
import { WorkflowStatusChips } from './components/WorkflowStatusChips.js';
import { TerminalDrawer, type TerminalDrawerState } from './components/TerminalDrawer.js';
import { LeftStatusColumn } from './components/LeftStatusColumn.js';
import { BrowserTaskRow, BrowserWorkflowRow } from './components/BrowserListRows.js';
import { useTheme } from './lib/theme.js';
import { InvokerTerminal, type InvokerTerminalLine, type PlanningTerminalMode } from './components/InvokerTerminal.js';
import { Toaster, toast } from 'sonner';
import { Button } from './components/primitives/index.js';
import { ChevronDownIcon, PlayIcon } from './components/icons/index.js';
import { CommandPalette, COMMAND_PALETTE_MAX_ROWS } from './components/CommandPalette.js';
import {
  getAttentionTaskEntries,
  getRunningTaskEntries,
  getSortedWorkflows,
  formatTaskStatus,
  formatWorkflowStatus,
} from './lib/workflow-progress-surfaces.js';
import { computeSearchResults, type SearchResult } from './lib/search.js';
import { displayWorkerTaskId, formatWorkerValue, getActiveWorkerAction, getWorkerDisplayCopy } from './lib/worker-display.js';
import {
  isExperimentSpawnPivotTask,
  EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE,
} from './isExperimentSpawnPivot.js';
import {
  createGraphCameraCommandIssuer,
  type GraphCameraCommand,
  type GraphCameraCommandInput,
  type GraphCameraCommandIssuer,
  type GraphCameraViewport,
  type GraphScope,
} from './lib/graph-camera.js';
import type { SystemDiagnostics } from '@invoker/contracts';

type ModalState =
  | { type: 'none' }
  | { type: 'input'; task: TaskState }
  | { type: 'approval'; task: TaskState; action: 'approve' | 'reject' }
  | { type: 'experiment'; task: TaskState }
  | { type: 'replace'; task: TaskState };

type KeyboardRegion = 'workflowGraph' | 'taskGraph' | 'inspector' | 'bottomBar' | 'planning';
type GraphKeyboardRegion = Extract<KeyboardRegion, 'workflowGraph' | 'taskGraph'>;
type ContextMenuCloseOptions = { restoreFocus?: boolean };
type ContextMenuState = { x: number; y: number; taskId: string; returnFocusRegion?: GraphKeyboardRegion };
type WorkflowContextMenuState = { x: number; y: number; workflowId: string; returnFocusRegion?: GraphKeyboardRegion };
const KEYBOARD_REGION_ORDER: readonly KeyboardRegion[] = ['planning', 'workflowGraph', 'taskGraph', 'inspector', 'bottomBar'];
const GRAPH_KEYBOARD_REGION_ORDER: readonly KeyboardRegion[] = ['workflowGraph', 'taskGraph', 'inspector', 'bottomBar'];
const SIDEBAR_NAV_ITEM_SELECTOR = '[data-sidebar-nav-item]';
export const SELECTED_WORKFLOW_VANISH_GRACE_MS = 1000;
const STATUS_KEY_ORDER: readonly WorkflowStatus[] = [
  'completed',
  'running',
  'failed',
  'closed',
  'pending',
  'review_ready',
  'awaiting_approval',
  'blocked',
  'fixing_with_ai',
  'stale',
];
const EDITABLE_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '.xterm',
  '[role="dialog"] input',
  '[role="dialog"] textarea',
].join(',');
const SYSTEM_SETUP_AUTO_OPEN_DELAY_MS = 1200;
const RAIL_LIST_FRAME_CLASS = 'flex min-h-0 flex-1 flex-col';
const RAIL_SCROLL_BODY_CLASS = 'min-h-0 flex-1 overflow-y-auto';

function notifyMutationError(rawTitle: string, err: unknown): void {
  console.error(rawTitle, err);
  const title = rawTitle.replace(/[:\s]+$/, '');
  const description = err instanceof Error ? err.message : typeof err === 'string' ? err : undefined;
  toast.error(title, description ? { description } : undefined);
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
type PlanningSessionView = Omit<InAppPlanningSessionSummary, 'messages'> & {
  messages: InvokerTerminalLine[];
  input: string;
  busy: boolean;
  conversationKey: string;
  mode: PlanningTerminalMode;
  terminalSession?: TerminalSessionDescriptor | null;
  terminalBusy?: boolean;
  terminalError?: string | null;
};

function planningSessionFromSummary(
  summary: InAppPlanningSessionSummary,
  overrides: Partial<PlanningSessionView> = {},
): PlanningSessionView {
  const restoredTerminalSession = summary.terminalSessionId
    ? {
        sessionId: summary.terminalSessionId,
        taskId: `planning:${summary.id}`,
        kind: 'planning' as const,
        planningSessionId: summary.id,
        status: summary.terminalStatus ?? ('running' as const),
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

type PlanningStreamState = {
  text: string;
  status: 'streaming' | 'failed';
};

function makeInitialPlanningSession(now: string = new Date().toISOString()): PlanningSessionView {
  return {
    id: 'local-planning-session-1',
    title: 'Untitled plan',
    status: 'still_discussing',
    presetKey: '',
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

function planningSessionSummaryToView(session: InAppPlanningSessionSummary): PlanningSessionView {
  return {
    ...session,
    messages: session.messages.map((line) => ({
      id: line.id,
      text: line.text,
      role: line.role,
      ...(line.tone ? { tone: line.tone } : {}),
    })),
    input: '',
    busy: false,
    conversationKey: session.id,
  };
}

function planningNeedsAttention(status: InAppPlanningSessionStatus): boolean {
  return status === 'waiting_for_answer' || status === 'draft_ready';
}

function previewPlanningMessage(session: PlanningSessionView): string {
  const last = [...session.messages].reverse().find((line) => line.role !== 'system') ?? session.messages.at(-1);
  return last?.text.replace(/\s+/g, ' ').trim() || 'No messages yet';
}

function planningSessionStatusLabel(session: PlanningSessionView): string {
  if (session.busy) return 'Working';
  if (session.status === 'draft_ready') return 'Draft ready';
  if (session.status === 'waiting_for_answer') return 'Waiting for answer';
  if (session.status === 'submitted') return 'Submitted';
  return 'Still discussing';
}

function relativePlanningUpdatedAt(value: string): string {
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

interface PlanningTypingTelemetryState {
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

function createPlanningTypingTelemetryContext({
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

function isTextInputElement(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
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

function PlanningSessionStatusIcon({
  busy,
  status,
}: {
  busy: boolean;
  status: InAppPlanningSessionStatus;
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
  return <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0" aria-hidden="true" />;
}


function sidebarNavOrder(item: HTMLElement): number {
  const order = Number(item.dataset.sidebarNavOrder);
  return Number.isFinite(order) ? order : Number.POSITIVE_INFINITY;
}

function getOrderedSidebarNavItems(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(SIDEBAR_NAV_ITEM_SELECTOR)].sort((a, b) => {
    const aOrder = sidebarNavOrder(a);
    const bOrder = sidebarNavOrder(b);
    if (aOrder !== bOrder) return aOrder < bOrder ? -1 : 1;
    if (a === b) return 0;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(EDITABLE_SELECTOR));
}

function normalizedSearchText(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

function workerActionTarget(action: WorkerActionSummary): string {
  if (action.taskId) return `Task: ${displayWorkerTaskId(action.taskId)}`;
  return `${formatWorkerValue(action.subjectType)}: ${action.subjectId}`;
}

function workerLogTarget(log: WorkerLogEntry): string {
  if (log.taskId) return `Task: ${displayWorkerTaskId(log.taskId)}`;
  if (log.subjectType && log.subjectId) return `${formatWorkerValue(log.subjectType)}: ${log.subjectId}`;
  if (log.workflowId) return `Workflow: ${log.workflowId}`;
  return 'No target';
}

function workerStateLabel(worker: WorkerStatusEntry): string {
  const activeAction = getActiveWorkerAction(worker);
  if (activeAction) return `${formatWorkerValue(worker.lifecycle)} · ${formatWorkerValue(activeAction.status)}`;
  return formatWorkerValue(worker.lifecycle);
}

function workerLogTitle(log: WorkerLogEntry): string {
  return formatWorkerValue(log.eventType ?? log.actionType ?? log.source);
}

interface WorkflowContextMenuProps {
  x: number;
  y: number;
  workflowId: string;
  onOpenWorkflow: (workflowId: string) => void;
  onOpenPr: (workflowId: string) => void;
  onRetryWorkflow: (workflowId: string) => void;
  onRebaseRetry: (workflowId: string) => void;
  onRebaseRecreate: (workflowId: string) => void;
  onRecreateWorkflow: (workflowId: string) => void;
  onCancelWorkflow: (workflowId: string) => void;
  onDeleteWorkflow: (workflowId: string) => void;
  onDetachWorkflow: (workflowId: string) => void;
  onCopyWorkflowId: (workflowId: string) => void;
  /** True when this workflow has exactly one upstream dependency that can be detached from the UI. */
  canDetach: boolean;
  onClose: (options?: ContextMenuCloseOptions) => void;
  autoFocus?: boolean;
}

interface WorkflowMenuItem {
  id: string;
  label: string;
  className: string;
  action: () => void;
  separator?: boolean;
}

function stopMenuKeyboardEvent(event: KeyboardEvent | React.KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  if ('stopImmediatePropagation' in event) {
    event.stopImmediatePropagation();
  } else {
    event.nativeEvent.stopImmediatePropagation?.();
  }
}

function WorkflowContextMenu({
  x,
  y,
  workflowId,
  onOpenWorkflow,
  onOpenPr,
  onRetryWorkflow,
  onRebaseRetry,
  onRebaseRecreate,
  onRecreateWorkflow,
  onCancelWorkflow,
  onDeleteWorkflow,
  onDetachWorkflow,
  onCopyWorkflowId,
  canDetach,
  onClose,
  autoFocus = false,
}: WorkflowContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [position, setPosition] = useState({ left: x, top: y });
  const [showMore, setShowMore] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);

  useLayoutEffect(() => {
    if (!menuRef.current) return;

    const rect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = x;
    let top = y;

    if (rect.right > viewportWidth) {
      left = x - rect.width;
    }
    if (rect.bottom > viewportHeight) {
      top = y - rect.height;
    }

    left = Math.max(0, Math.min(left, viewportWidth - rect.width));
    top = Math.max(0, Math.min(top, viewportHeight - rect.height));
    setPosition({ left, top });
  }, [x, y, showMore]);

  useEffect(() => {
    const dismissFromOutsideTarget = (target: EventTarget | null, button?: number) => {
      if (button !== undefined && button !== 0) return;
      if (menuRef.current && !menuRef.current.contains(target as Node)) {
        onClose();
      }
    };
    const handlePointerDownCapture = (event: PointerEvent) => dismissFromOutsideTarget(event.target, event.button);
    const handleMouseDownCapture = (event: MouseEvent) => dismissFromOutsideTarget(event.target, event.button);
    const handleClickCapture = (event: MouseEvent) => dismissFromOutsideTarget(event.target, event.button);
    document.addEventListener('pointerdown', handlePointerDownCapture, true);
    document.addEventListener('mousedown', handleMouseDownCapture, true);
    document.addEventListener('click', handleClickCapture, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownCapture, true);
      document.removeEventListener('mousedown', handleMouseDownCapture, true);
      document.removeEventListener('click', handleClickCapture, true);
    };
  }, [onClose]);

  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
    setFocusedIndex(0);
    if (autoFocus) return;
    const frame = requestAnimationFrame(() => menuRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  const runAction = (action: (workflowId: string) => void) => {
    action(workflowId);
    onClose({ restoreFocus: autoFocus });
  };

  const buttonClass = 'w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-muted';
  const dangerButtonClass = 'w-full px-3 py-1.5 text-left text-sm text-red-300 hover:bg-muted';
  const visibleItems: WorkflowMenuItem[] = [
    { id: 'open-workflow', label: 'Open Workflow', className: buttonClass, action: () => runAction(onOpenWorkflow) },
    { id: 'open-pr', label: 'Open PR', className: buttonClass, action: () => runAction(onOpenPr) },
    { id: 'retry-workflow', label: 'Retry Workflow', className: buttonClass, action: () => runAction(onRetryWorkflow) },
    { id: 'copy-workflow-id', label: 'Copy Workflow ID', className: buttonClass, action: () => runAction(onCopyWorkflowId) },
    ...(!showMore
      ? [{
          id: 'more',
          label: 'More',
          className: 'w-full px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted',
          separator: true,
          action: () => {
            setShowMore(true);
            setFocusedIndex(4);
          },
        }]
      : [
          { id: 'rebase-retry', label: 'Rebase and Retry', className: buttonClass, separator: true, action: () => runAction(onRebaseRetry) },
          { id: 'rebase-recreate', label: 'Rebase and Recreate', className: dangerButtonClass, action: () => runAction(onRebaseRecreate) },
          { id: 'recreate-workflow', label: 'Recreate Workflow', className: dangerButtonClass, action: () => runAction(onRecreateWorkflow) },
          { id: 'cancel-workflow', label: 'Cancel Workflow', className: dangerButtonClass, action: () => runAction(onCancelWorkflow) },
          ...(canDetach
            ? [{ id: 'detach-workflow', label: 'Detach Upstream Workflow', className: dangerButtonClass, action: () => runAction(onDetachWorkflow) }]
            : []),
          { id: 'delete-workflow', label: 'Delete Workflow', className: dangerButtonClass, action: () => runAction(onDeleteWorkflow) },
        ]),
  ];

  useEffect(() => {
    if (focusedIndex >= visibleItems.length) {
      setFocusedIndex(Math.max(0, visibleItems.length - 1));
    }
  }, [focusedIndex, visibleItems.length]);

  useEffect(() => {
    if (!autoFocus || visibleItems.length === 0) return;
    const frame = requestAnimationFrame(() => {
      itemRefs.current[focusedIndex]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, focusedIndex, visibleItems.length]);

  const handleKeyDown = useCallback((event: KeyboardEvent | React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      stopMenuKeyboardEvent(event);
      onClose({ restoreFocus: autoFocus });
      return;
    }

    if (visibleItems.length === 0) return;

    if (event.key === 'ArrowDown') {
      stopMenuKeyboardEvent(event);
      setFocusedIndex((index) => (index + 1) % visibleItems.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      stopMenuKeyboardEvent(event);
      setFocusedIndex((index) => (index - 1 + visibleItems.length) % visibleItems.length);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      stopMenuKeyboardEvent(event);
      visibleItems[focusedIndex]?.action();
    }
  }, [autoFocus, focusedIndex, onClose, visibleItems]);

  useEffect(() => {
    const handleDocumentKeyDownCapture = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Enter' ||
        event.key === ' '
      ) {
        handleKeyDown(event);
      }
    };

    document.addEventListener('keydown', handleDocumentKeyDownCapture, true);
    return () => document.removeEventListener('keydown', handleDocumentKeyDownCapture, true);
  }, [handleKeyDown]);

  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid="workflow-context-menu"
      className="fixed z-50 min-w-[200px] rounded-lg border border-border-strong bg-secondary py-1 shadow-xl"
      style={{ left: position.left, top: position.top }}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onClick={(event) => event.stopPropagation()}
    >
      {visibleItems.map((item, index) => (
        <div key={item.id}>
          {item.separator && <div className="my-1 border-t border-border-strong" />}
          <button
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            type="button"
            role="menuitem"
            onClick={item.action}
            onMouseEnter={() => setFocusedIndex(index)}
            className={`${item.className} ${index === focusedIndex ? 'bg-muted' : ''}`}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}

function EmptyPlanGraphCta({
  creationError,
  draftPlan,
  onCreateWorkflow,
  onGoHome,
}: {
  creationError?: string;
  draftPlan?: { name: string; taskCount: number };
  onCreateWorkflow?: () => void;
  onGoHome: () => void;
}): JSX.Element {
  if (draftPlan && onCreateWorkflow) {
    return (
      <aside className="h-full w-full border-l border-border bg-background/90 p-4" data-testid="empty-plan-graph-cta">
        <div className="rounded-xl border border-border bg-card/70 p-4">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Draft review</div>
          <h2 className="mt-1 text-sm font-semibold text-foreground">{draftPlan.name}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {draftPlan.taskCount} task{draftPlan.taskCount === 1 ? '' : 's'} ready to create as a workflow.
          </p>
          {creationError && (
            <p className="mt-3 text-xs text-destructive">{creationError}</p>
          )}
          <button
            type="button"
            data-testid="planning-create-workflow"
            onClick={onCreateWorkflow}
            className="mt-4 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Create workflow
          </button>
        </div>
      </aside>
    );
  }
  return (
    <aside className="h-full w-full border-l border-border bg-background/90 p-4" data-testid="empty-plan-graph-cta">
      <div className="rounded-xl border border-border bg-card/70 p-4">
        <h2 className="text-sm font-semibold text-foreground">No plan yet</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Draft a plan from Home, then review the graph and start ready work.
        </p>
        <ol className="mt-3 space-y-3 text-sm text-muted-foreground">
          <li>
            <div className="font-medium text-foreground">1. Type a goal</div>
            <div className="mt-1 text-xs text-muted-foreground">Describe the change in the planning chat.</div>
          </li>
          <li>
            <div className="font-medium text-foreground">2. Review the plan</div>
            <div className="mt-1 text-xs text-muted-foreground">Check the graph before starting work.</div>
          </li>
          <li>
            <div className="font-medium text-foreground">3. Start ready work</div>
            <div className="mt-1 text-xs text-muted-foreground">Use Start ready work when the plan looks right.</div>
          </li>
        </ol>
        <button
          type="button"
          data-testid="empty-plan-graph-go-home"
          onClick={onGoHome}
          className="mt-4 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          Go to Home to draft
        </button>
      </div>
    </aside>
  );
}

function EmptyInspectorPlaceholder(): JSX.Element {
  return (
    <aside className="h-full w-full border-l border-border bg-background/90 p-4">
      <div className="rounded-xl border border-dashed border-border bg-card/50 p-4">
        <h2 className="text-sm font-semibold text-foreground">No task selected</h2>
        <p className="mt-2 text-sm text-muted-foreground">Select a task in the graph to see details.</p>
        <p className="mt-2 text-xs text-muted-foreground">Status, logs, and actions will appear here.</p>
      </div>
    </aside>
  );
}

export function hasMergeConflictExecution(task: TaskState | undefined): boolean {
  if (!task) return false;
  if (task.execution.mergeConflict) return true;
  const rawError = task.execution.error;
  if (typeof rawError !== 'string') return false;
  try {
    const parsed = JSON.parse(rawError) as { type?: unknown };
    return parsed?.type === 'merge_conflict';
  } catch {
    return false;
  }
}

type SelectedWorkflowGraphSnapshot = {
  workflowId: string;
  workflow: WorkflowMeta;
  tasks: Map<string, TaskState>;
};

export function App() {
  const [graphRefreshSequence, setGraphRefreshSequence] = useState(0);
  const handleTaskGraphSnapshotApplied = useCallback(() => {
    setGraphRefreshSequence((sequence) => sequence + 1);
  }, []);
  const { tasks, workflows, clearTasks, refreshTaskGraph } = useTasks({
    onTaskGraphSnapshotApplied: handleTaskGraphSnapshotApplied,
  });
  useEffect(() => {
    if (workflows.size === 0 || tasks.size > 0) return;
    void refreshTaskGraph();
  }, [refreshTaskGraph, tasks.size, workflows.size]);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const [viewMode, setViewMode] = useState<'dag' | 'history' | 'timeline' | 'queue' | 'actionGraph'>('dag');
  const {
    graph: actionGraph,
    error: actionGraphError,
    refreshActionGraph,
  } = useActionGraphSnapshot(2_000, viewMode === 'actionGraph');
  const trackAcceptedMutation = useCallback((result: unknown) => {
    if (result && typeof result === 'object' && (result as { accepted?: unknown }).accepted === true) {
      void refreshActionGraph();
      void refreshTaskGraph();
    }
  }, [refreshActionGraph, refreshTaskGraph]);
  const coreActivityByWorkflow = useMemo(
    () => groupWorkflowCoreActivity(actionGraph?.nodes ?? []),
    [actionGraph],
  );
  const invoker = useInvoker();
  const queueStatus = useQueueStatus();
  const [workerStatus, refreshWorkerStatus] = useWorkerStatus();
  const handleStartWorker = useCallback(async (kind: string) => {
    await invoker.startWorker(kind);
    void refreshWorkerStatus();
  }, [invoker, refreshWorkerStatus]);
  const handleStopWorker = useCallback(async (kind: string) => {
    await invoker.stopWorker(kind);
    void refreshWorkerStatus();
  }, [invoker, refreshWorkerStatus]);
  const runningTaskIds = useMemo(
    () => new Set((queueStatus?.running ?? []).map((entry) => entry.taskId)),
    [queueStatus],
  );
  const appRootRef = useRef<HTMLDivElement>(null);
  const graphSurfaceRef = useRef<HTMLDivElement>(null);
  const graphActionsMenuRef = useRef<HTMLDivElement>(null);
  const startReadyMenuRef = useRef<HTMLDivElement>(null);
  const lastGoodSelectedWorkflowGraphRef = useRef<SelectedWorkflowGraphSnapshot | null>(null);
  const suppressDagSurfaceDismissRef = useRef(false);
  const contextMenuTaskRef = useRef<TaskState | null>(null);
  const [sidebarSurface, setSidebarSurface] = useState<SidebarSurface>('home');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selectedTaskIdRef = useRef<string | null>(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;
  const [selectedWorkerKind, setSelectedWorkerKind] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [reviewGateByWorkflowId, setReviewGateByWorkflowId] = useState<Record<string, ReviewGateQueryResponse | null>>({});
  const [stickySelectedWorkflow, setStickySelectedWorkflow] = useState<WorkflowMeta | null>(null);
  const [workflowSelectionDismissed, setWorkflowSelectionDismissed] = useState(false);
  const [selectedWorkflowVanished, setSelectedWorkflowVanished] = useState(false);
  const [modal, setModal] = useState<ModalState>({ type: 'none' });
  const [hasLoadedPlan, setHasLoadedPlan] = useState(false);
  const [planName, setPlanName] = useState<string | null>(null);
  const [planningSessions, setPlanningSessions] = useState<PlanningSessionView[]>(() => [makeInitialPlanningSession()]);
  const planningSessionsRef = useRef<PlanningSessionView[]>(planningSessions);
  const activePlanningSessionIdRef = useRef('local-planning-session-1');
  const pendingPlanningStreamSessionIdsRef = useRef<Set<string>>(new Set());
  const planningStreamSessionAliasesRef = useRef<Map<string, string>>(new Map());
  const [activePlanningSessionId, setActivePlanningSessionId] = useState('local-planning-session-1');
  const nextPlanningSessionLocalIdRef = useRef(2);
  const nextTerminalLineIdRef = useRef(1);
  const [planningStreamBySessionId, setPlanningStreamBySessionId] = useState<Record<string, PlanningStreamState>>({});
  const [planningPresetOptions, setPlanningPresetOptions] = useState<Array<{ key: string; label: string; isDefault?: boolean }>>([]);
  const [selectedPlanningPresetKey, setSelectedPlanningPresetKey] = useState('');
  const [planningSubmitError, setPlanningSubmitError] = useState<{ title: string; message: string } | null>(null);
  const [planningTerminalExpanded, setPlanningTerminalExpanded] = useState(false);
  const activePlanningSession = useMemo(
    () => planningSessions.find((session) => session.id === activePlanningSessionId) ?? planningSessions[0] ?? makeInitialPlanningSession(),
    [activePlanningSessionId, planningSessions],
  );
  const activePlanningStream = planningStreamBySessionId[activePlanningSession.id] ?? null;
  const activePlanningConversationKey = activePlanningSession.conversationKey;
  const terminalLines = activePlanningSession.messages;
  const planningInput = activePlanningSession.input;
  const planningSessionId = activePlanningSession.id.startsWith('local-') ? null : activePlanningSession.id;
  const draftPlanAvailable = activePlanningSession.draftPlanAvailable;
  const draftPlanSummary = activePlanningSession.draftPlanSummary;
  const activePlanningSessionBusy = activePlanningSession.busy;
  const activePlanningSessionSubmitted = activePlanningSession.status === 'submitted';
  const activePlanningMode = activePlanningSession.mode ?? 'chat';
  const activePlanningTerminalSession = activePlanningSession.terminalSession ?? null;
  const activePlanningTerminalBusy = Boolean(activePlanningSession.terminalBusy);
  const activePlanningTerminalError = activePlanningSession.terminalError ?? null;
  const planningAttentionCount = useMemo(
    () => planningSessions.filter((session) => planningNeedsAttention(session.status)).length,
    [planningSessions],
  );

  useEffect(() => {
    planningSessionsRef.current = planningSessions;
  }, [planningSessions]);
  const [graphMaximized, setGraphMaximized] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const [selectedActionNodeId, setSelectedActionNodeId] = useState<string | null>(null);
  const selectedActionNode = useMemo(
    () => actionGraph?.nodes.find((node) => node.id === selectedActionNodeId) ?? null,
    [actionGraph, selectedActionNodeId],
  );
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [remoteTargets, setRemoteTargets] = useState<string[]>([]);
  const [executionPools, setExecutionPools] = useState<string[]>([]);
  const [executionHarnesses, setExecutionHarnesses] = useState<ExecutionHarnessOption[]>([]);
  const [executionDefaults, setExecutionDefaults] = useState<ExecutionDefaults | null>(null);
  const [statusFilters, setStatusFilters] = useState<Set<WorkflowStatus>>(new Set());
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(
    () => (typeof window !== 'undefined' ? window.__INVOKER_BOOTSTRAP__?.runtimeStatus ?? null : null),
  );
  const activePlanningReadOnly = activePlanningSessionSubmitted || runtimeStatus?.readOnly === true;
  const [systemDiagnostics, setSystemDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [showSystemSetup, setShowSystemSetup] = useState(false);
  const [showSystemBanner, setShowSystemBanner] = useState(false);
  const [mutationFailuresByTaskId, setMutationFailuresByTaskId] = useState<Map<string, WorkflowMutationFailedEvent>>(new Map());
  const [installSkillsPending, setInstallSkillsPending] = useState(false);
  const [installSkillsError, setInstallSkillsError] = useState<string | null>(null);
  const [updateCliPending, setUpdateCliPending] = useState(false);
  const [setupPending, setSetupPending] = useState(false);
  const [setupResult, setSetupResult] = useState<InvokerSetupResult | null>(null);
  const [updateCliError, setUpdateCliError] = useState<string | null>(null);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [inspectorManualOpen, setInspectorManualOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1600 : window.innerWidth));
  const [advancedMetadataExpanded, setAdvancedMetadataExpanded] = useState(false);
  const [terminalDrawerState, setTerminalDrawerState] = useState<TerminalDrawerState>('minimized');
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionDescriptor[]>([]);
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<string | null>(null);
  const [workflowContextMenu, setWorkflowContextMenu] = useState<WorkflowContextMenuState | null>(null);
  const [graphActionsMenuOpen, setGraphActionsMenuOpen] = useState(false);
  const [startReadyMenuOpen, setStartReadyMenuOpen] = useState(false);
  const [startReadyBusy, setStartReadyBusy] = useState(false);
  const [startReadyPreview, setStartReadyPreview] = useState<StartReadyResult | null>(null);
  const [startReadyPreviewMode, setStartReadyPreviewMode] = useState<
    'failed' | 'failedAndPending' | 'failedPendingAndRunning'
  >('failed');
  // Transient, user-visible outcome line for a confirmed workflow detach.
  const [detachNotice, setDetachNotice] = useState<string | null>(null);
  const [keyboardRegion, setKeyboardRegion] = useState<KeyboardRegion>('planning');
  const [previousGraphRegion, setPreviousGraphRegion] = useState<KeyboardRegion>('workflowGraph');
  const [planningContextCollapsed, setPlanningContextCollapsed] = useState(true);
  const [planningSessionRailCollapsed, setPlanningSessionRailCollapsed] = useState(false);
  // Typed graph camera state. The graph viewport is user-owned after the
  // initial render: only explicit navigation commands (issued through the
  // central factory) move it. No per-handler event++/requestId++ counters.
  const cameraIssuerRef = useRef<GraphCameraCommandIssuer | null>(null);
  if (!cameraIssuerRef.current) {
    cameraIssuerRef.current = createGraphCameraCommandIssuer();
  }
  const [cameraCommand, setCameraCommand] = useState<GraphCameraCommand | null>(null);
  const workflowGraphViewportRef = useRef<GraphCameraViewport | null>(null);
  const [bottomStatusIndex, setBottomStatusIndex] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const uiPerfThrottleRef = useRef<Record<string, number>>({});
  const planningTypingStateRef = useRef<PlanningTypingTelemetryState | null>(null);
  const planningTypingSequenceRef = useRef(0);
  const planningTypingFrameIdsRef = useRef<Set<number>>(new Set());
  const systemSetupAutoOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingSystemSetupAutoOpen = useCallback(() => {
    if (systemSetupAutoOpenTimerRef.current !== null) {
      clearTimeout(systemSetupAutoOpenTimerRef.current);
      systemSetupAutoOpenTimerRef.current = null;
    }
  }, []);

  const scheduleSystemSetupAutoOpen = useCallback(() => {
    cancelPendingSystemSetupAutoOpen();
    systemSetupAutoOpenTimerRef.current = setTimeout(() => {
      systemSetupAutoOpenTimerRef.current = null;
      setShowSystemSetup(true);
    }, SYSTEM_SETUP_AUTO_OPEN_DELAY_MS);
  }, [cancelPendingSystemSetupAutoOpen]);

  useEffect(() => cancelPendingSystemSetupAutoOpen, [cancelPendingSystemSetupAutoOpen]);

  const lastShiftAtRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const refreshSystemDiagnostics = useCallback(() => {
    window.invoker?.getSystemDiagnostics?.().then((diagnostics) => {
      setSystemDiagnostics(diagnostics);
      const missingRequired = diagnostics.tools.some((tool) => tool.required && !tool.installed);
      const hasAgent = diagnostics.tools.some((tool) => (tool.id === 'claude' || tool.id === 'codex') && tool.installed);
      const needsBundledPrompt = Boolean(diagnostics.isPackaged && diagnostics.bundledSkills?.promptRecommended);
      if (missingRequired || !hasAgent || needsBundledPrompt) {
        setShowSystemBanner(true);
      }
      if (needsBundledPrompt) {
        scheduleSystemSetupAutoOpen();
      } else {
        cancelPendingSystemSetupAutoOpen();
      }
    }).catch(() => {});
  }, [cancelPendingSystemSetupAutoOpen, scheduleSystemSetupAutoOpen]);

  useEffect(() => {
    planningSessionsRef.current = planningSessions;
  }, [planningSessions]);

  useEffect(() => {
    activePlanningSessionIdRef.current = activePlanningSessionId;
  }, [activePlanningSessionId]);

  useEffect(() => {
    window.invoker?.getRemoteTargets?.().then(setRemoteTargets).catch(() => {});
    window.invoker?.getExecutionPools?.().then(setExecutionPools).catch(() => {});
    window.invoker?.getExecutionHarnesses?.().then(setExecutionHarnesses).catch(() => {});
    window.invoker?.getExecutionDefaults?.().then(setExecutionDefaults).catch(() => {});
    window.invoker?.getRuntimeStatus?.().then(setRuntimeStatus).catch(() => {});
    window.invoker?.getPlanningPresets?.()
      .then((options) => {
        const resolved = Array.isArray(options) && options.length > 0
          ? options.map((option) => ({ key: option.key, label: option.label, isDefault: option.isDefault }))
          : [{ key: 'codex', label: 'Codex', isDefault: true }];
        setPlanningPresetOptions(resolved);
        setSelectedPlanningPresetKey(resolved.find((option) => option.isDefault)?.key ?? resolved[0]?.key ?? 'codex');
      })
      .catch(() => {
        setPlanningPresetOptions([{ key: 'codex', label: 'Codex', isDefault: true }]);
        setSelectedPlanningPresetKey('codex');
    });
    refreshSystemDiagnostics();
  }, [refreshSystemDiagnostics]);

  useEffect(() => {
    let cancelled = false;
    window.invoker?.planningChatList?.()
      .then((response) => {
        if (cancelled || !response.ok || response.sessions.length === 0) return;
        const currentSessions = planningSessionsRef.current;
        const first = currentSessions[0];
        const onlyInitialPlaceholder = currentSessions.length === 1
          && first?.id === 'local-planning-session-1'
          && first.input === ''
          && first.messages.every((line) => line.role === 'system');
        if (!onlyInitialPlaceholder) return;
        const restored = response.sessions.map(planningSessionSummaryToView);
        const maxLineId = restored.reduce((max, session) => (
          Math.max(max, ...session.messages.map((line) => line.id))
        ), 1);
        nextTerminalLineIdRef.current = Math.max(nextTerminalLineIdRef.current, maxLineId + 1);
        setPlanningSessions(restored);
        setActivePlanningSessionId(restored[0]?.id ?? 'local-planning-session-1');
        setSelectedPlanningPresetKey((current) => current || restored[0]?.presetKey || current);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    window.invoker?.terminalList?.().then((list) => {
      if (Array.isArray(list) && list.length > 0) {
        setTerminalSessions(list);
        setActiveTerminalSessionId(list[list.length - 1]?.sessionId ?? null);
        setTerminalDrawerState('partial');
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const hydratePlanningSessions = async (): Promise<void> => {
      const planningChatList = window.invoker?.planningChatList;
      if (!planningChatList) return;
      try {
        const [chatList, terminalList] = await Promise.all([
          planningChatList(),
          window.invoker?.planningTerminalList?.().catch(() => [] as TerminalSessionDescriptor[]) ?? Promise.resolve([] as TerminalSessionDescriptor[]),
        ]);
        if (cancelled || !chatList.ok || chatList.sessions.length === 0) return;
        const terminalsByPlanningSession = new Map(
          terminalList
            .filter((session) => session.kind === 'planning' && session.planningSessionId)
            .map((session) => [session.planningSessionId!, session]),
        );
        const restored = chatList.sessions.map((summary) => {
          const liveTerminal = terminalsByPlanningSession.get(summary.id);
          return liveTerminal
            ? planningSessionFromSummary(summary, { terminalSession: liveTerminal })
            : planningSessionFromSummary(summary);
        });
        setPlanningSessions(restored);
        setActivePlanningSessionId((currentSessionId) => (
          restored.some((session) => session.id === currentSessionId)
            ? currentSessionId
            : restored[0]?.id ?? currentSessionId
        ));
        const maxLineId = Math.max(1, ...restored.flatMap((session) => session.messages.map((message) => message.id)));
        nextTerminalLineIdRef.current = Math.max(nextTerminalLineIdRef.current, maxLineId + 1);
      } catch {
        /* planning chat restore is best-effort */
      }
    };
    void hydratePlanningSessions();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!graphMaximized && !planningTerminalExpanded) return;
      event.stopPropagation();
      setGraphMaximized(false);
      setPlanningTerminalExpanded(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [graphMaximized, planningTerminalExpanded]);


  useEffect(() => {
    const unsubscribe = window.invoker?.onTerminalExit?.((event) => {
      setTerminalSessions((prev) =>
        prev.map((session) =>
          session.sessionId === event.sessionId
            ? { ...session, status: 'exited', exitCode: event.exitCode }
            : session,
        ),
      );
      setPlanningSessions((prev) =>
        prev.map((session) => (
          session.terminalSession?.sessionId === event.sessionId
            ? {
                ...session,
                terminalSession: {
                  ...session.terminalSession,
                  status: 'exited',
                  exitCode: event.exitCode,
                },
              }
            : session
        )),
      );
    });
    return () => { unsubscribe?.(); };
  }, []);

  useEffect(() => {
    const unsubscribe = window.invoker?.onRuntimeStatus?.((status) => {
      setRuntimeStatus(status);
    });
    return () => { unsubscribe?.(); };
  }, []);

  useEffect(() => {
    const unsubscribe = window.invoker?.onPlanningChatStream?.((event) => {
      const sessionId = typeof event.sessionId === 'string' ? event.sessionId.trim() : '';
      if (!sessionId || typeof event.chunk !== 'string' || !event.chunk) return;

      const sessions = planningSessionsRef.current;
      const isStreamingTarget = (session: PlanningSessionView): boolean => (
        session.busy || pendingPlanningStreamSessionIdsRef.current.has(session.id)
      );
      const matchingSession = sessions.find((session) => session.id === sessionId);
      const aliasedSessionId = planningStreamSessionAliasesRef.current.get(sessionId);
      const aliasedSession = aliasedSessionId
        ? sessions.find((session) => session.id === aliasedSessionId)
        : undefined;
      const activeLocalSession = sessions.find((session) => (
        session.id === activePlanningSessionIdRef.current
        && session.id.startsWith('local-')
        && isStreamingTarget(session)
      ));
      const localBusySession = sessions.find((session) => session.id.startsWith('local-') && isStreamingTarget(session));
      const targetSessionId = matchingSession && isStreamingTarget(matchingSession)
        ? matchingSession.id
        : aliasedSession && isStreamingTarget(aliasedSession)
          ? aliasedSession.id
          : activeLocalSession?.id ?? localBusySession?.id;
      if (!targetSessionId) return;
      if (!matchingSession) {
        planningStreamSessionAliasesRef.current.set(sessionId, targetSessionId);
      }

      setPlanningStreamBySessionId((prev) => {
        const current = prev[targetSessionId];
        return {
          ...prev,
          [targetSessionId]: {
            text: `${current?.text ?? ''}${event.chunk}`,
            status: 'streaming',
          },
        };
      });
    });
    return () => { unsubscribe?.(); };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.invoker) return;

    const shouldEmit = (key: string, minIntervalMs: number): boolean => {
      const now = Date.now();
      const prev = uiPerfThrottleRef.current[key] ?? 0;
      if (now - prev < minIntervalMs) return false;
      uiPerfThrottleRef.current[key] = now;
      return true;
    };

    // Track per-tick renderer timer drift. Keep the old cumulative schedule
    // value in the payload so startup perf data can prove whether a large
    // number is an actual single stall or accumulated timer throttling.
    const intervalMs = 1000;
    let expected = performance.now() + intervalMs;
    let previousTickAt = performance.now();
    let tickCount = 0;
    const lagInterval = setInterval(() => {
      const now = performance.now();
      const tickDeltaMs = now - previousTickAt;
      const lagMs = Math.max(0, tickDeltaMs - intervalMs);
      const cumulativeLagMs = Math.max(0, now - expected);
      previousTickAt = now;
      expected = now + intervalMs;
      tickCount += 1;
      if ((lagMs >= 250 || cumulativeLagMs >= 250) && shouldEmit('event_loop_lag', 5000)) {
        // Defensive: window.invoker is undefined in vitest/jsdom environments.
        void window.invoker?.reportUiPerf?.('renderer_event_loop_lag', {
          lagMs: Math.round(lagMs),
          cumulativeLagMs: Math.round(cumulativeLagMs),
          tickDeltaMs: Math.round(tickDeltaMs),
          tickCount,
          visibilityState: document.visibilityState,
          hasFocus: document.hasFocus(),
        });
      }
    }, intervalMs);

    // Track long tasks if supported by Chromium.
    let perfObserver: PerformanceObserver | null = null;
    if ('PerformanceObserver' in window) {
      try {
        perfObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration >= 200 && shouldEmit('long_task', 3000)) {
              // Defensive: window.invoker is undefined in vitest/jsdom environments.
              void window.invoker?.reportUiPerf?.('renderer_long_task', {
                durationMs: Math.round(entry.duration),
                name: entry.name,
              });
            }
          }
        });
        perfObserver.observe({ entryTypes: ['longtask'] });
      } catch {
        // Browser might not support longtask in this context.
      }
    }

    return () => {
      clearInterval(lagInterval);
      perfObserver?.disconnect();
    };
  }, []);
  useEffect(() => {
    planningTypingStateRef.current = {
      tasks,
      workflows,
      viewMode,
      terminalDrawerState,
      selectedTaskId,
      selectedWorkflowId,
      hasLoadedPlan,
    };
  }, [
    tasks,
    workflows,
    viewMode,
    terminalDrawerState,
    selectedTaskId,
    selectedWorkflowId,
    hasLoadedPlan,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const scheduleFrame = (callback: FrameRequestCallback): number => {
      if (typeof window.requestAnimationFrame === 'function') {
        return window.requestAnimationFrame(callback);
      }
      return window.setTimeout(() => callback(performance.now()), 0);
    };
    const cancelFrame = (id: number) => {
      if (typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(id);
      } else {
        window.clearTimeout(id);
      }
    };

    const reportTypingLag = (event: Event) => {
      const target = event.target;
      if (!isTextInputElement(target)) return;
      if (!appRootRef.current?.contains(target)) return;

      const startedAt = performance.now();
      const sequence = ++planningTypingSequenceRef.current;
      const inputEvent = event as InputEvent;
      const targetTestId = target.getAttribute('data-testid') ?? undefined;
      const targetAriaLabel = target.getAttribute('aria-label') ?? undefined;
      const targetName = targetTestId ?? targetAriaLabel ?? target.tagName.toLowerCase();
      const valueLength = target.value.length;

      const frameId = scheduleFrame(() => {
        planningTypingFrameIdsRef.current.delete(frameId);
        const telemetryState = planningTypingStateRef.current;
        void window.invoker?.reportUiPerf?.(PLANNING_TYPING_LAG_METRIC, {
          ...(telemetryState ? createPlanningTypingTelemetryContext(telemetryState) : {}),
          sequence,
          eventType: event.type,
          lagMs: Math.round(performance.now() - startedAt),
          targetName,
          targetTagName: target.tagName.toLowerCase(),
          targetValueLength: valueLength,
          targetReadOnly: target.readOnly,
          targetDisabled: target.disabled,
          targetIsComposing: inputEvent.isComposing === true,
          inputType: typeof inputEvent.inputType === 'string' ? inputEvent.inputType : undefined,
        });
      });
      planningTypingFrameIdsRef.current.add(frameId);
    };

    document.addEventListener('input', reportTypingLag, true);
    document.addEventListener('change', reportTypingLag, true);
    return () => {
      document.removeEventListener('input', reportTypingLag, true);
      document.removeEventListener('change', reportTypingLag, true);
      for (const frameId of planningTypingFrameIdsRef.current) {
        cancelFrame(frameId);
      }
      planningTypingFrameIdsRef.current.clear();
    };
  }, [appRootRef]);

  const selectedTask = selectedTaskId ? tasks.get(selectedTaskId) ?? null : null;
  const selectedWorker = workerStatus?.workers.find((worker) => worker.kind === selectedWorkerKind) ?? null;
  const liveContextMenuTask = contextMenu ? tasks.get(contextMenu.taskId) ?? null : null;
  useEffect(() => {
    if (!contextMenu) {
      contextMenuTaskRef.current = null;
      return;
    }
    if (liveContextMenuTask) {
      contextMenuTaskRef.current = liveContextMenuTask;
    }
  }, [contextMenu, liveContextMenuTask]);
  const contextMenuTask = liveContextMenuTask
    ?? (contextMenu && contextMenuTaskRef.current?.id === contextMenu.taskId
      ? contextMenuTaskRef.current
      : null);
  const selectedWorkflowTaskCount = useMemo(() => {
    if (!selectedWorkflowId) return 0;
    let count = 0;
    for (const task of tasks.values()) {
      if (task.config.workflowId === selectedWorkflowId) count += 1;
    }
    return count;
  }, [selectedWorkflowId, tasks]);
  const selectedWorkflow = useMemo(() => {
    if (selectedWorkflowId) {
      return workflows.get(selectedWorkflowId)
        ?? (stickySelectedWorkflow?.id === selectedWorkflowId && selectedWorkflowTaskCount > 0
          ? stickySelectedWorkflow
          : null);
    }
    if (selectedTask?.config.workflowId) {
      return workflows.get(selectedTask.config.workflowId)
        ?? (stickySelectedWorkflow?.id === selectedTask.config.workflowId
          ? stickySelectedWorkflow
          : null);
    }
    return null;
  }, [selectedWorkflowId, selectedTask, workflows, stickySelectedWorkflow, selectedWorkflowTaskCount]);
  const miniDagTasks = useMemo(() => {
    const activeWorkflowId = selectedWorkflow?.id ?? selectedWorkflowId;
    if (!activeWorkflowId) return new Map<string, TaskState>();
    const next = new Map<string, TaskState>();
    for (const task of tasks.values()) {
      if (task.config.workflowId === activeWorkflowId) {
        next.set(task.id, task);
      }
    }
    return next;
  }, [selectedWorkflow, selectedWorkflowId, tasks]);
  useEffect(() => {
    if (selectedWorkflow && miniDagTasks.size > 0) {
      lastGoodSelectedWorkflowGraphRef.current = {
        workflowId: selectedWorkflow.id,
        workflow: selectedWorkflow,
        tasks: miniDagTasks,
      };
      return;
    }

    if (!selectedWorkflowId || workflowSelectionDismissed || tasks.size === 0) {
      lastGoodSelectedWorkflowGraphRef.current = null;
    }
  }, [miniDagTasks, selectedWorkflow, selectedWorkflowId, tasks.size, workflowSelectionDismissed]);

  const displayedSelectedWorkflowGraph = useMemo<SelectedWorkflowGraphSnapshot | null>(() => {
    if (selectedWorkflow && miniDagTasks.size > 0) {
      return {
        workflowId: selectedWorkflow.id,
        workflow: selectedWorkflow,
        tasks: miniDagTasks,
      };
    }

    const snapshot = lastGoodSelectedWorkflowGraphRef.current;
    const selectedTaskWorkflowId = selectedTask?.config.workflowId ?? null;
    const selectedTaskForcesDifferentWorkflow = selectedTaskWorkflowId !== null
      && snapshot !== null
      && selectedTaskWorkflowId !== snapshot.workflowId;
    if (
      snapshot
      && selectedWorkflowId === snapshot.workflowId
      && snapshot.tasks.size > 0
      && !workflowSelectionDismissed
      && !selectedTaskForcesDifferentWorkflow
      && tasks.size > 0
    ) {
      return snapshot;
    }

    return null;
  }, [miniDagTasks, selectedTask, selectedWorkflow, selectedWorkflowId, tasks.size, workflowSelectionDismissed]);
  const isSelectedWorkflowGraphRefreshing = displayedSelectedWorkflowGraph !== null
    && !(selectedWorkflow && miniDagTasks.size > 0);
  const selectedWorkflowGraphAvailable = displayedSelectedWorkflowGraph !== null;
  const selectedTaskDagWorkflows = useMemo(() => {
    const workflowForDag = displayedSelectedWorkflowGraph?.workflow ?? selectedWorkflow;
    if (!workflowForDag || workflows.has(workflowForDag.id)) {
      return workflows;
    }
    const next = new Map(workflows);
    next.set(workflowForDag.id, workflowForDag);
    return next;
  }, [displayedSelectedWorkflowGraph, selectedWorkflow, workflows]);

  useEffect(() => {
    const workflowId = selectedWorkflow?.id;
    if (!workflowId) return;
    const getReviewGate = window.invoker?.getReviewGate;
    if (!getReviewGate) {
      setReviewGateByWorkflowId((prev) => ({ ...prev, [workflowId]: null }));
      return;
    }
    let cancelled = false;
    void getReviewGate(workflowId)
      .then((reviewGate) => {
        if (cancelled) return;
        setReviewGateByWorkflowId((prev) => ({ ...prev, [workflowId]: reviewGate }));
      })
      .catch(() => {
        if (cancelled) return;
        setReviewGateByWorkflowId((prev) => ({ ...prev, [workflowId]: null }));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkflow?.id, tasks]);

  useEffect(() => {
    if (!selectedWorkflowId) {
      setStickySelectedWorkflow(null);
      return;
    }
    const liveWorkflow = workflows.get(selectedWorkflowId);
    if (liveWorkflow) {
      setStickySelectedWorkflow(liveWorkflow);
      return;
    }
    if (selectedWorkflowTaskCount === 0) {
      setStickySelectedWorkflow((prev) => (prev?.id === selectedWorkflowId ? null : prev));
    }
  }, [selectedWorkflowId, selectedWorkflowTaskCount, workflows]);

  const selectedWorkflowPresent = selectedWorkflowId !== null
    && (workflows.has(selectedWorkflowId) || selectedWorkflowTaskCount > 0);
  useEffect(() => {
    if (selectedWorkflowId === null || selectedWorkflowPresent) {
      setSelectedWorkflowVanished(false);
      return;
    }
    const timer = setTimeout(() => setSelectedWorkflowVanished(true), SELECTED_WORKFLOW_VANISH_GRACE_MS);
    return () => clearTimeout(timer);
  }, [selectedWorkflowId, selectedWorkflowPresent]);

  useEffect(() => {
    if (selectedTask?.config.workflowId) {
      setWorkflowSelectionDismissed(false);
      setSelectedWorkflowId(selectedTask.config.workflowId);
      return;
    }
    if (selectedWorkflowId && (workflows.has(selectedWorkflowId) || selectedWorkflowTaskCount > 0)) {
      return;
    }
    if (workflowSelectionDismissed) {
      return;
    }
    if (selectedWorkflowId && !selectedWorkflowVanished) {
      return;
    }
    const firstWorkflowId = workflows.keys().next().value as string | undefined;
    setSelectedWorkflowId(firstWorkflowId ?? null);
  }, [selectedTask, selectedWorkflowId, selectedWorkflowTaskCount, selectedWorkflowVanished, workflowSelectionDismissed, workflows]);

  const handleStatusClick = useCallback((filterKey: WorkflowStatus, event: React.MouseEvent) => {
    setStatusFilters(prev => {
      if (event.ctrlKey || event.metaKey) {
        // Toggle: add if absent, remove if present
        const next = new Set(prev);
        if (next.has(filterKey)) {
          next.delete(filterKey);
        } else {
          next.add(filterKey);
        }
        return next;
      } else {
        // Isolate: if already the sole filter, clear all; otherwise set to this filter only
        if (prev.size === 1 && prev.has(filterKey)) {
          return new Set<WorkflowStatus>();
        }
        return new Set([filterKey]);
      }
    });
  }, []);

  const visibleStatusKeys = useMemo(() => {
    const counts = new Map<WorkflowStatus, number>();
    for (const workflow of workflows.values()) {
      counts.set(workflow.status, (counts.get(workflow.status) ?? 0) + 1);
    }
    return STATUS_KEY_ORDER.filter((key) => key === 'completed' || key === 'running' || key === 'failed' || key === 'pending' || (counts.get(key) ?? 0) > 0);
  }, [workflows]);
  const workflowEntries = useMemo(() => getSortedWorkflows(workflows, tasks), [workflows, tasks]);
  const attentionTaskIdsWithFailures = useMemo(
    () => new Set(mutationFailuresByTaskId.keys()),
    [mutationFailuresByTaskId],
  );
  const attentionEntries = useMemo(
    () => getAttentionTaskEntries(tasks, workflows, attentionTaskIdsWithFailures),
    [tasks, workflows, attentionTaskIdsWithFailures],
  );
  const runningEntries = useMemo(() => getRunningTaskEntries(tasks, workflows, queueStatus), [tasks, workflows, queueStatus]);
  const commandPaletteWorkflowEntries = useMemo(
    () => workflowEntries.slice(0, COMMAND_PALETTE_MAX_ROWS),
    [workflowEntries],
  );
  const commandPaletteAttentionEntries = useMemo(
    () => attentionEntries.slice(0, COMMAND_PALETTE_MAX_ROWS),
    [attentionEntries],
  );
  const commandPaletteRunningEntries = useMemo(
    () => runningEntries.slice(0, COMMAND_PALETTE_MAX_ROWS),
    [runningEntries],
  );

  const searchResults = useMemo<SearchResult[]>(
    () => computeSearchResults(searchQuery, tasks, workflows),
    [searchQuery, tasks, workflows],
  );

  useEffect(() => {
    setSearchActiveIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (searchOpen) {
      const frame = requestAnimationFrame(() => searchInputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [searchOpen]);

  const focusKeyboardRegion = useCallback((region: KeyboardRegion) => {
    setKeyboardRegion(region);
    if (region === 'workflowGraph' || region === 'taskGraph') {
      setPreviousGraphRegion(region);
    }
    requestAnimationFrame(() => {
      const root = document.querySelector<HTMLElement>(`[data-keyboard-region="${region}"]`);
      if (!root) return;
      if (region === 'inspector') {
        const [firstNavItem] = getOrderedSidebarNavItems(root);
        (firstNavItem ?? root).focus();
        return;
      }
      root.focus();
    });
  }, []);

  const nodeCenter = useCallback((element: Element | null) => {
    const rect = element?.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) {
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return { x: Math.max(24, window.innerWidth / 2), y: Math.max(24, window.innerHeight / 2) };
  }, []);

  // The only path that mints camera commands. The issuer owns the monotonic
  // sequence, so no selection handler keeps its own counter.
  const issueCameraCommand = useCallback((input: GraphCameraCommandInput): GraphCameraCommand => {
    const command = cameraIssuerRef.current!.issue(input);
    setCameraCommand(command);
    return command;
  }, []);

  const handleWorkflowGraphViewportSnapshot = useCallback((viewport: GraphCameraViewport) => {
    workflowGraphViewportRef.current = viewport;
  }, []);

  useEffect(() => {
    if (workflows.size === 0) {
      workflowGraphViewportRef.current = null;
    }
  }, [workflows.size]);

  const armSuppressDagSurfaceDismiss = useCallback(() => {
    suppressDagSurfaceDismissRef.current = true;
    queueMicrotask(() => {
      suppressDagSurfaceDismissRef.current = false;
    });
  }, []);

  const selectWorkflowById = useCallback((workflowId: string) => {
    armSuppressDagSurfaceDismiss();
    setWorkflowSelectionDismissed(false);
    setSelectedWorkflowId(workflowId);
    setSelectedTaskId(null);
    setContextMenu(null);
    setWorkflowContextMenu(null);
    focusKeyboardRegion('workflowGraph');
  }, [armSuppressDagSurfaceDismiss, focusKeyboardRegion]);

  const selectTaskById = useCallback((taskId: string) => {
    const task = tasksRef.current.get(taskId);
    if (!task) return;
    setSelectedTaskId(task.id);
    setWorkflowSelectionDismissed(false);
    if (task.config.workflowId) {
      setSelectedWorkflowId(task.config.workflowId);
    }
    setInspectorCollapsed(false);
    setInspectorManualOpen(true);
    setContextMenu(null);
    setWorkflowContextMenu(null);
    focusKeyboardRegion('taskGraph');
  }, [focusKeyboardRegion]);

  useEffect(() => {
    const unsubscribe = window.invoker?.onWorkflowMutationFailed?.((event) => {
      const failedTaskId = event.taskId;
      if (failedTaskId) {
        setMutationFailuresByTaskId((prev) => new Map(prev).set(failedTaskId, event));
        return;
      }
      notifyMutationError('Mutation failed', event.message);
    });
    return () => { unsubscribe?.(); };
  }, []);

  const selectRelativeNode = useCallback((direction: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight') => {
    const inTaskGraph = keyboardRegion === 'taskGraph';
    const nodeRecords = inTaskGraph
      ? [...document.querySelectorAll<HTMLElement>('[data-testid="selected-workflow-mini-dag"] .react-flow__node')]
          .map((element) => {
            const testId = element.getAttribute('data-testid') ?? '';
            const id = testId.startsWith('rf__node-') ? testId.slice('rf__node-'.length) : null;
            return id && tasks.has(id) ? { id, element } : null;
          })
          .filter((record): record is { id: string; element: HTMLElement } => Boolean(record))
      : [...document.querySelectorAll<HTMLElement>('[data-testid^="workflow-node-"]')]
          .map((element) => {
            const testId = element.getAttribute('data-testid') ?? '';
            const id = testId.slice('workflow-node-'.length);
            return workflows.has(id) ? { id, element } : null;
          })
          .filter((record): record is { id: string; element: HTMLElement } => Boolean(record));

    if (nodeRecords.length === 0) return;
    const currentId = inTaskGraph ? selectedTaskId : selectedWorkflow?.id ?? selectedWorkflowId;
    const sorted = [...nodeRecords].sort((a, b) => a.id.localeCompare(b.id));
    const current = nodeRecords.find((record) => record.id === currentId) ?? sorted[0];
    const currentRect = current.element.getBoundingClientRect();
    const currentCenter = {
      x: currentRect.left + currentRect.width / 2,
      y: currentRect.top + currentRect.height / 2,
    };
    const isHorizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
    const sign = direction === 'ArrowLeft' || direction === 'ArrowUp' ? -1 : 1;
    const candidates = nodeRecords
      .filter((record) => record.id !== current.id)
      .map((record) => {
        const rect = record.element.getBoundingClientRect();
        const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const primaryDelta = isHorizontal ? center.x - currentCenter.x : center.y - currentCenter.y;
        const secondaryDelta = isHorizontal ? center.y - currentCenter.y : center.x - currentCenter.x;
        return { ...record, primaryDelta, secondaryDelta };
      })
      .filter((record) => Math.sign(record.primaryDelta) === sign && Math.abs(record.primaryDelta) > 0)
      .sort((a, b) => Math.abs(a.primaryDelta) - Math.abs(b.primaryDelta) || Math.abs(a.secondaryDelta) - Math.abs(b.secondaryDelta));

    const fallbackIndex = Math.max(0, sorted.findIndex((record) => record.id === current.id));
    const fallback = sorted[Math.min(sorted.length - 1, Math.max(0, fallbackIndex + sign))];
    const next = candidates[0] ?? fallback;
    if (!next || next.id === current.id) return;
    if (inTaskGraph) {
      selectTaskById(next.id);
    } else {
      selectWorkflowById(next.id);
    }
  }, [keyboardRegion, selectTaskById, selectWorkflowById, selectedTaskId, selectedWorkflow?.id, selectedWorkflowId, tasks, workflows]);

  const openSelectedContextMenu = useCallback(() => {
    if (keyboardRegion === 'taskGraph' && selectedTaskId && tasks.has(selectedTaskId)) {
      const element = [...document.querySelectorAll<HTMLElement>('[data-testid="selected-workflow-mini-dag"] .react-flow__node')]
        .find((candidate) => (candidate.getAttribute('data-testid') ?? '') === `rf__node-${selectedTaskId}`);
      const point = nodeCenter(element ?? null);
      setWorkflowContextMenu(null);
      setContextMenu({ x: point.x, y: point.y, taskId: selectedTaskId, returnFocusRegion: 'taskGraph' });
      return;
    }
    const workflowId = selectedWorkflow?.id ?? selectedWorkflowId;
    if (keyboardRegion === 'workflowGraph' && workflowId && workflows.has(workflowId)) {
      const element = document.querySelector<HTMLElement>(`[data-testid="workflow-node-${workflowId}"]`);
      const point = nodeCenter(element);
      setContextMenu(null);
      setWorkflowContextMenu({ x: point.x, y: point.y, workflowId, returnFocusRegion: 'workflowGraph' });
    }
  }, [keyboardRegion, nodeCenter, selectedTaskId, selectedWorkflow?.id, selectedWorkflowId, tasks, workflows]);

  const activateSearchResult = useCallback((result: SearchResult | undefined) => {
    if (!result) return;
    setSearchOpen(false);
    setSearchQuery('');
    if (result.kind === 'workflow') {
      selectWorkflowById(result.id);
      return;
    }
    selectTaskById(result.id);
  }, [selectTaskById, selectWorkflowById]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (contextMenu || workflowContextMenu) {
        return;
      }

      if (event.key === 'Shift' && !isEditableKeyboardTarget(event.target)) {
        const now = Date.now();
        if (now - lastShiftAtRef.current <= 450) {
          event.preventDefault();
          setSearchOpen(true);
          setSearchQuery('');
          setSearchActiveIndex(0);
          lastShiftAtRef.current = 0;
          return;
        }
        lastShiftAtRef.current = now;
      }

      if (searchOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setSearchOpen(false);
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSearchActiveIndex((index) => Math.min(searchResults.length - 1, index + 1));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSearchActiveIndex((index) => Math.max(0, index - 1));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          activateSearchResult(searchResults[searchActiveIndex]);
        }
        return;
      }

      if ((graphMaximized || planningTerminalExpanded) && event.key === 'Escape') {
        return;
      }
      if (isEditableKeyboardTarget(event.target) || modal.type !== 'none') return;

      // F1 is the keyboard-only one-shot center on selection. It is already
      // ignored for input/modal/terminal/editable targets by the guard above.
      if (event.key === 'F1') {
        event.preventDefault();
        const inTaskGraph = keyboardRegion === 'taskGraph';
        const scope: GraphScope = inTaskGraph ? 'task' : 'workflow';
        const target = inTaskGraph ? selectedTaskId : (selectedWorkflow?.id ?? selectedWorkflowId);
        if (target) {
          issueCameraCommand({ kind: 'centerSelection', scope, target, reason: 'f1-center' });
        }
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        const regionOrder = sidebarSurface === 'home' ? (['planning'] as const) : GRAPH_KEYBOARD_REGION_ORDER;
        const currentIndex = Math.max(0, regionOrder.indexOf(keyboardRegion as typeof regionOrder[number]));
        const nextIndex = event.shiftKey
          ? (currentIndex - 1 + regionOrder.length) % regionOrder.length
          : (currentIndex + 1) % regionOrder.length;
        focusKeyboardRegion(regionOrder[nextIndex]);
        return;
      }

      if (event.key === 'Escape') {
        if (keyboardRegion === 'inspector') {
          event.preventDefault();
          focusKeyboardRegion(previousGraphRegion);
        } else if (keyboardRegion === 'taskGraph' && selectedWorkflow && miniDagTasks.size > 0) {
          event.preventDefault();
          setContextMenu(null);
          setWorkflowContextMenu(null);
          setSelectedTaskId(null);
          setSelectedWorkflowId(null);
          setWorkflowSelectionDismissed(true);
          focusKeyboardRegion('workflowGraph');
        }
        return;
      }

      if (keyboardRegion === 'workflowGraph' || keyboardRegion === 'taskGraph') {
        if (event.key === ' ' && keyboardRegion === 'workflowGraph') {
          const workflowId = selectedWorkflow?.id ?? selectedWorkflowId;
          if (workflowId) {
            event.preventDefault();
            setContextMenu(null);
            setWorkflowContextMenu(null);
            setWorkflowSelectionDismissed(false);
            focusKeyboardRegion('taskGraph');
            return;
          }
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          openSelectedContextMenu();
          return;
        }
        if (event.key === 'Home' && keyboardRegion === 'taskGraph') {
          event.preventDefault();
          const firstTask = [...miniDagTasks.values()].sort((a, b) => a.dependencies.length - b.dependencies.length || a.id.localeCompare(b.id))[0];
          if (firstTask) selectTaskById(firstTask.id);
          return;
        }
        if (event.key === 'End' && keyboardRegion === 'taskGraph') {
          event.preventDefault();
          const terminalTask = [...miniDagTasks.values()].sort((a, b) => Number(Boolean(b.config.isMergeNode)) - Number(Boolean(a.config.isMergeNode)) || b.id.localeCompare(a.id))[0];
          if (terminalTask) selectTaskById(terminalTask.id);
          return;
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          selectRelativeNode(event.key);
        }
        return;
      }

      if (keyboardRegion === 'inspector') {
        const root = document.querySelector<HTMLElement>('[data-keyboard-region="inspector"]');
        if (!root) return;
        const navItems = getOrderedSidebarNavItems(root);
        if (navItems.length === 0) return;
        const activeIndex = navItems.findIndex((item) => item === document.activeElement);
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          const nextIndex = activeIndex < 0 ? 0 : Math.min(navItems.length - 1, activeIndex + 1);
          navItems[nextIndex]?.focus();
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          const prevIndex = activeIndex < 0 ? 0 : Math.max(0, activeIndex - 1);
          navItems[prevIndex]?.focus();
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          const active = activeIndex >= 0 ? navItems[activeIndex] : null;
          if (active?.dataset.sidebarExpandable === 'true') {
            active.click();
          }
        }
        return;
      }

      if (keyboardRegion === 'bottomBar') {
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setTerminalDrawerState('partial');
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setTerminalDrawerState('minimized');
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          setBottomStatusIndex((index) => Math.min(visibleStatusKeys.length - 1, index + 1));
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          setBottomStatusIndex((index) => Math.max(0, index - 1));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          const key = visibleStatusKeys[bottomStatusIndex] ?? visibleStatusKeys[0];
          if (key) {
            handleStatusClick(key as WorkflowStatus, { ctrlKey: false, metaKey: false } as React.MouseEvent);
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    activateSearchResult,
    bottomStatusIndex,
    contextMenu,
    focusKeyboardRegion,
    graphMaximized,
    planningTerminalExpanded,
    handleStatusClick,
    issueCameraCommand,
    keyboardRegion,
    miniDagTasks,
    modal.type,
    openSelectedContextMenu,
    previousGraphRegion,
    sidebarSurface,
    searchActiveIndex,
    searchOpen,
    searchResults,
    selectRelativeNode,
    selectTaskById,
    selectedTaskId,
    selectedWorkflow,
    selectedWorkflowId,
    visibleStatusKeys,
    workflowContextMenu,
  ]);
  const missingRequiredTool = systemDiagnostics?.tools.find((tool) => tool.required && !tool.installed) ?? null;
  const installedAgentCount = systemDiagnostics?.tools.filter((tool) => (tool.id === 'claude' || tool.id === 'codex') && tool.installed).length ?? 0;
  const needsBundledSkillsPrompt = Boolean(systemDiagnostics?.isPackaged && systemDiagnostics?.bundledSkills?.promptRecommended);

  // ── DAG interaction ───────────────────────────────────────
  const handleTaskClick = useCallback((task: TaskState) => {
    selectTaskById(task.id);
  }, [selectTaskById]);

  const requestTerminalForTaskId = useCallback(async (taskId: string) => {
    const task = tasks.get(taskId);
    if (task && isExperimentSpawnPivotTask(task)) {
      window.alert(EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE);
      return;
    }
    setTerminalDrawerState('partial');
    const result = await (window.__INVOKER_TEST_OPEN_TERMINAL__ ?? window.invoker?.openTerminal)?.(taskId);
    if (!result) return;
    if (!result.opened) {
      window.alert(result.reason ?? 'Cannot open terminal for this task.');
      return;
    }
    const session = result.session;
    if (session) {
      setTerminalSessions((prev) => {
        const idx = prev.findIndex((s) => s.sessionId === session.sessionId);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = session;
          return next;
        }
        return [...prev, session];
      });
      setActiveTerminalSessionId(session.sessionId);
    }
  }, [tasks]);

  const openTerminalForTaskId = useCallback(async (taskId: string) => {
    const existingRunningSession = terminalSessions.find(
      (session) => session.taskId === taskId && session.status === 'running',
    );
    if (existingRunningSession) {
      setTerminalDrawerState('partial');
      setActiveTerminalSessionId(existingRunningSession.sessionId);
      return;
    }

    await requestTerminalForTaskId(taskId);
  }, [requestTerminalForTaskId, terminalSessions]);

  const handleTaskDoubleClick = useCallback(async (task: TaskState) => {
    setSelectedTaskId(task.id);
    await openTerminalForTaskId(task.id);
  }, [openTerminalForTaskId]);

  const handleTaskContextMenu = useCallback((task: TaskState, event: React.MouseEvent) => {
    setSelectedTaskId(task.id);
    setWorkflowSelectionDismissed(false);
    if (task.config.workflowId) {
      setSelectedWorkflowId(task.config.workflowId);
    }
    setWorkflowContextMenu(null);
    setContextMenu({ x: event.clientX, y: event.clientY, taskId: task.id });
  }, []);

  const handleWorkflowClick = useCallback((workflowId: string) => {
    armSuppressDagSurfaceDismiss();
    setWorkflowSelectionDismissed(false);
    setSelectedWorkflowId(workflowId);
    setSelectedTaskId(null);
    setContextMenu(null);
    setWorkflowContextMenu(null);
  }, [armSuppressDagSurfaceDismiss]);

  const handleWorkflowContextMenu = useCallback((event: React.MouseEvent<Element>, workflowId: string) => {
    event.preventDefault();
    setWorkflowSelectionDismissed(false);
    setSelectedWorkflowId(workflowId);
    setSelectedTaskId(null);
    setContextMenu(null);
    setWorkflowContextMenu({ x: event.clientX, y: event.clientY, workflowId });
  }, []);
  useEffect(() => {
    if (sidebarSurface === 'workflows') {
      const activeWorkflowId = selectedWorkflow?.id ?? selectedWorkflowId;
      if (!workflowEntries.length) {
        if (selectedTaskId !== null || activeWorkflowId !== null) {
          setSelectedTaskId(null);
          setSelectedWorkflowId(null);
          setWorkflowSelectionDismissed(false);
        }
        return;
      }
      if (workflowEntries.some((entry) => entry.workflow.id === activeWorkflowId)) {
        return;
      }
      if (activeWorkflowId !== null && !selectedWorkflowVanished) {
        return;
      }
      selectWorkflowById(workflowEntries[0].workflow.id);
      return;
    }

    if (sidebarSurface === 'attention') {
      if (!attentionEntries.length) {
        if (selectedTaskId !== null || selectedWorkflowId !== null) {
          setSelectedTaskId(null);
          setSelectedWorkflowId(null);
          setWorkflowSelectionDismissed(false);
        }
        return;
      }
      if (attentionEntries.some((entry) => entry.task.id === selectedTaskId)) {
        return;
      }
      selectTaskById(attentionEntries[0].task.id);
      return;
    }

  }, [
    attentionEntries,
    selectTaskById,
    selectWorkflowById,
    selectedTaskId,
    selectedWorkflow?.id,
    selectedWorkflowId,
    selectedWorkflowVanished,
    sidebarSurface,
    workflowEntries,
  ]);

  useEffect(() => {
    if (!workerStatus?.workers.some((worker) => worker.kind === selectedWorkerKind)) {
      setSelectedWorkerKind(null);
    }
  }, [selectedWorkerKind, workerStatus]);

  useEffect(() => {
    if (sidebarSurface !== 'workers') return;
    if (selectedWorkerKind && workerStatus?.workers.some((worker) => worker.kind === selectedWorkerKind)) return;
    setSelectedWorkerKind(workerStatus?.workers[0]?.kind ?? null);
  }, [selectedWorkerKind, sidebarSurface, workerStatus]);
  useEffect(() => {
    // Camera resnap for browser surfaces only; plan graph handles its own fit on enter.
    if (viewMode !== 'dag' || (sidebarSurface !== 'workflows' && sidebarSurface !== 'attention') || !selectedWorkflowGraphAvailable) {
      return;
    }

    let cancelled = false;
    const fitFrame = requestAnimationFrame(() => {
      if (cancelled) return;
      issueCameraCommand({ kind: 'fitInitial', scope: 'task', reason: 'browser-surface' });

      const selectedTaskId = selectedTaskIdRef.current;
      if (!selectedTaskId) return;
      requestAnimationFrame(() => {
        if (cancelled) return;
        requestAnimationFrame(() => {
          if (cancelled) return;
          issueCameraCommand({ kind: 'centerSelection', scope: 'task', target: selectedTaskId, reason: 'browser-selection' });
        });
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(fitFrame);
    };
  }, [
    issueCameraCommand,
    selectedWorkflowGraphAvailable,
    sidebarSurface,
    viewMode,
  ]);


  const handleDagSurfaceClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (contextMenu || workflowContextMenu) {
      setContextMenu(null);
      setWorkflowContextMenu(null);
      return;
    }

    if (suppressDagSurfaceDismissRef.current) {
      return;
    }

    const target = event.target as HTMLElement;
    if (
      target.closest('[data-testid^="workflow-node-"]') ||
      target.closest('[data-testid="selected-workflow-mini-dag"]') ||
      target.closest('.react-flow__node') ||
      target.closest('[role="menu"]')
    ) {
      return;
    }

    setSelectedTaskId(null);
    setSelectedWorkflowId(null);
    setWorkflowSelectionDismissed(true);
  }, [contextMenu, workflowContextMenu]);

  const handleRestartTask = useCallback(async (taskId: string) => {
    if (!invoker) return;
    setContextMenu(null);
    try {
      const result = await invoker.restartTask(taskId);
      trackAcceptedMutation(result);
    } catch (err) {
      notifyMutationError('Failed to restart task', err);
    }
  }, [invoker, trackAcceptedMutation]);

  const handleOpenTerminal = useCallback(
    (taskId: string) => {
      setContextMenu(null);
      void requestTerminalForTaskId(taskId);
    },
    [requestTerminalForTaskId],
  );

  const handleCloseTerminalSession = useCallback(async (sessionId: string) => {
    setTerminalSessions((prev) => prev.filter((session) => session.sessionId !== sessionId));
    setActiveTerminalSessionId((prev) => {
      if (prev !== sessionId) return prev;
      const remaining = terminalSessions.filter((session) => session.sessionId !== sessionId);
      return remaining[remaining.length - 1]?.sessionId ?? null;
    });
    try {
      await window.invoker?.terminalClose?.(sessionId);
    } catch {
      /* best-effort */
    }
  }, [terminalSessions]);

  const terminalTaskLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const task of tasks.values()) {
      labels.set(task.id, task.description || task.id);
    }
    return labels;
  }, [tasks]);

  const handleReplaceTask = useCallback((taskId: string) => {
    setContextMenu(null);
    const task = tasks.get(taskId);
    if (task) setModal({ type: 'replace', task });
  }, [tasks]);

  const handleReplaceSubmit = useCallback(async (taskId: string, replacements: TaskReplacementDef[]) => {
    try {
      const result = await window.invoker?.replaceTask(taskId, replacements);
      trackAcceptedMutation(result);
    } catch (err) {
      notifyMutationError('Failed to replace task:', err);
    }
  }, [trackAcceptedMutation]);

  const handleRebaseRetry = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.rebaseRetry(workflowId);
      trackAcceptedMutation(result);
    } catch (err) {
      notifyMutationError('Rebase and Retry failed:', err);
    }
  }, [trackAcceptedMutation]);

  const handleRebaseRecreate = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.rebaseRecreate(workflowId);
      trackAcceptedMutation(result);
    } catch (err) {
      notifyMutationError('Rebase and Recreate failed:', err);
    }
  }, [trackAcceptedMutation]);

  const handleRetryWorkflow = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.retryWorkflow(workflowId);
      trackAcceptedMutation(result);
    } catch (err) {
      notifyMutationError('Retry Workflow failed:', err);
    }
  }, [trackAcceptedMutation]);

  const handleRecreateWorkflow = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.recreateWorkflow(workflowId);
      trackAcceptedMutation(result);
    } catch (err) {
      notifyMutationError('Recreate Workflow failed:', err);
    }
  }, [trackAcceptedMutation]);

  const handleRecreateTask = useCallback(async (taskId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.recreateTask(taskId);
      trackAcceptedMutation(result);
    } catch (err) {
      notifyMutationError('Recreate from Task failed:', err);
    }
  }, [trackAcceptedMutation]);

  const handleRecreateDownstream = useCallback(async (taskId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.recreateDownstream(taskId);
      trackAcceptedMutation(result);
    } catch (err) {
      notifyMutationError('Recreate Downstream failed:', err);
    }
  }, [trackAcceptedMutation]);

  const handleDeleteTask = useCallback(async (taskId: string) => {
    setContextMenu(null);
    const confirmed = window.confirm(
      `Delete task "${taskId}"? Its dependents will use this task's upstream dependencies.`
    );
    if (!confirmed) return;
    try {
      const result = await window.invoker?.deleteTask(taskId);
      trackAcceptedMutation(result);
      if (selectedTaskId === taskId) {
        setSelectedTaskId(null);
      }
      refreshTaskGraph();
    } catch (err) {
      notifyMutationError('Delete Task failed:', err);
    }
  }, [refreshTaskGraph, selectedTaskId, trackAcceptedMutation]);

  const handleDeleteWorkflow = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    const confirmed = window.confirm(
      'Delete this workflow and all its tasks? This cannot be undone.',
    );
    if (!confirmed) return;
    try {
      const result = await window.invoker?.deleteWorkflow(workflowId);
      trackAcceptedMutation(result);
      setSelectedTaskId(null);
      if (selectedWorkflowId === workflowId) {
        setSelectedWorkflowId(null);
      }
      refreshTaskGraph();
    } catch (err) {
      notifyMutationError('Delete Workflow failed:', err);
    }
  }, [refreshTaskGraph, selectedWorkflowId, trackAcceptedMutation]);

  const handleDetachWorkflow = useCallback(async (workflowId: string) => {
    setWorkflowContextMenu(null);
    const workflow = workflows.get(workflowId);
    const deps = workflow?.externalDependencies ?? [];
    // UI detach targets a single upstream edge so the confirmation can name
    // both endpoints. Multi-upstream detach stays on the headless/API surface.
    if (deps.length !== 1) return;
    const upstreamWorkflowId = deps[0].workflowId;
    const downstreamName = workflow?.name ?? workflowId;
    const upstreamName = workflows.get(upstreamWorkflowId)?.name ?? upstreamWorkflowId;
    const confirmed = window.confirm(
      `Detach "${downstreamName}" from upstream "${upstreamName}"?\n\n` +
      `This removes the active dependency so "${downstreamName}" no longer waits on "${upstreamName}". ` +
      `The detached lineage stays visible in the graph. Neither workflow is deleted.`,
    );
    if (!confirmed) return;
    try {
      await window.invoker?.detachWorkflow(workflowId, upstreamWorkflowId);
      setDetachNotice(
        `Detached "${downstreamName}" from upstream "${upstreamName}". The active dependency was removed; detached lineage remains visible.`,
      );
      refreshTaskGraph();
    } catch (err) {
      notifyMutationError('Detach Workflow failed:', err);
    }
  }, [workflows, refreshTaskGraph]);

  useEffect(() => {
    if (!detachNotice) return;
    const timer = setTimeout(() => setDetachNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [detachNotice]);

  const handleFix = useCallback(async (taskId: string, agentName: string) => {
    setContextMenu(null);
    const task = tasks.get(taskId);
    if (task?.config.runnerKind === 'docker') {
      const proceed = window.confirm(
        'Note: AI CLI tools have known freeze issues inside Docker containers. ' +
        'The automated fix will run in non-interactive pipe mode which is unaffected.\n\n' +
        'However, double-clicking to resume the session interactively may freeze.\n\n' +
        `Proceed with Fix with ${agentName}?`,
      );
      if (!proceed) return;
    }
    try {
      const hasMergeConflict = hasMergeConflictExecution(task);
      const result = hasMergeConflict
        ? await window.invoker?.resolveConflict(taskId, agentName)
        : await window.invoker?.fixWithAgent(taskId, agentName);
      trackAcceptedMutation(result);
      refreshTaskGraph();
    } catch (err) {
      notifyMutationError('Fix failed:', err);
    }
  }, [tasks, trackAcceptedMutation]);

  const handleCancelTask = useCallback(async (taskId: string) => {
    setContextMenu(null);
    const confirmed = window.confirm(
      `Terminate task "${taskId}" and all downstream dependents?`
    );
    if (!confirmed) return;
    try {
      const result = await window.invoker?.cancelTask(taskId);
      trackAcceptedMutation(result);
    } catch (err) {
      notifyMutationError('Failed to cancel task:', err);
    }
  }, [trackAcceptedMutation]);

  const handleCancelWorkflow = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    const confirmed = window.confirm(
      `Cancel workflow "${workflowId}"? This cancels all active tasks in this workflow.`
    );
    if (!confirmed) return;
    try {
      const result = await window.invoker?.cancelWorkflow(workflowId);
      trackAcceptedMutation(result);
    } catch (err) {
      notifyMutationError('Failed to cancel workflow:', err);
    }
  }, [trackAcceptedMutation]);

  const handleOpenWorkflowPr = useCallback((workflowId: string) => {
    const workflowTasks = [...tasks.values()].filter((task) => task.config.workflowId === workflowId);
    const reviewUrl = workflowTasks.find((task) => task.execution.reviewUrl)?.execution.reviewUrl;
    if (reviewUrl) {
      window.open(reviewUrl, '_blank', 'noopener,noreferrer');
    }
    setWorkflowContextMenu(null);
  }, [tasks]);

  const handleCopyWorkflowId = useCallback((workflowId: string) => {
    navigator.clipboard?.writeText(workflowId).catch(() => {});
    setWorkflowContextMenu(null);
  }, []);

  const closeContextMenu = useCallback((options?: ContextMenuCloseOptions) => {
    const returnFocusRegion = options?.restoreFocus
      ? contextMenu?.returnFocusRegion ?? workflowContextMenu?.returnFocusRegion
      : undefined;
    setContextMenu(null);
    setWorkflowContextMenu(null);
    if (returnFocusRegion) {
      focusKeyboardRegion(returnFocusRegion);
    }
  }, [contextMenu, focusKeyboardRegion, workflowContextMenu]);

  const handleRefresh = useCallback(async () => {
    await refreshTaskGraph();
    void invoker?.checkPrStatuses?.();
  }, [invoker, refreshTaskGraph]);
  const updatePlanningSessionById = useCallback((sessionId: string, updater: (session: PlanningSessionView) => PlanningSessionView) => {
    setPlanningSessions((prev) => prev.map((session) => (
      session.id === sessionId ? updater(session) : session
    )));
  }, []);

  const updateActivePlanningSession = useCallback((updater: (session: PlanningSessionView) => PlanningSessionView) => {
    updatePlanningSessionById(activePlanningSessionId, updater);
  }, [activePlanningSessionId, updatePlanningSessionById]);

  const clearPlanningStreamForSessionIds = useCallback((sessionIds: Array<string | null | undefined>) => {
    const ids = new Set(sessionIds.filter((sessionId): sessionId is string => Boolean(sessionId)));
    if (ids.size === 0) return;
    setPlanningStreamBySessionId((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of ids) {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const forgetPlanningStreamAliasesForSessionIds = useCallback((sessionIds: Array<string | null | undefined>) => {
    const ids = new Set(sessionIds.filter((sessionId): sessionId is string => Boolean(sessionId)));
    if (ids.size === 0) return;
    for (const [streamSessionId, targetSessionId] of planningStreamSessionAliasesRef.current) {
      if (ids.has(streamSessionId) || ids.has(targetSessionId)) {
        planningStreamSessionAliasesRef.current.delete(streamSessionId);
      }
    }
  }, []);

  const keepPlanningStreamFailureForSessionIds = useCallback((sessionIds: Array<string | null | undefined>, message: string) => {
    const ids = new Set(sessionIds.filter((sessionId): sessionId is string => Boolean(sessionId)));
    if (ids.size === 0 || !message) return;
    setPlanningStreamBySessionId((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        const existing = next[id]?.text ?? '';
        const separator = existing && !existing.endsWith('\n') ? '\n' : '';
        next[id] = {
          text: existing ? `${existing}${separator}${message}` : message,
          status: 'failed',
        };
      }
      return next;
    });
  }, []);

  const setPlanningInput = useCallback((value: string) => {
    updateActivePlanningSession((session) => ({ ...session, input: value }));
  }, [updateActivePlanningSession]);

  const appendTerminalLine = useCallback((
    text: string,
    role: InvokerTerminalLine['role'] = 'system',
    tone?: InvokerTerminalLine['tone'],
  ) => {
    const id = nextTerminalLineIdRef.current;
    nextTerminalLineIdRef.current += 1;
    const updatedAt = new Date().toISOString();
    updateActivePlanningSession((session) => ({
      ...session,
      messages: [...session.messages, { id, text, role, tone }],
      updatedAt,
    }));
  }, [updateActivePlanningSession]);

  const handleStartReadyAction = useCallback(async (
    request: StartReadyRequest = {},
  ): Promise<StartReadyResult | null> => {
    if (!invoker?.startReady) return null;
    setStartReadyBusy(true);
    setStartReadyMenuOpen(false);
    try {
      const result = await invoker.startReady(request);
      if (!result.dryRun) {
        await refreshTaskGraph();
        void refreshActionGraph();
        if (result.started.length > 0 || result.recreatedWorkflowIds.length > 0) {
          const descriptionParts = [
            result.recreatedWorkflowIds.length > 0
              ? formatCount(result.recreatedWorkflowIds.length, 'workflow')
              : null,
            result.preview.recoverableTaskIds.length > 0
              ? formatCount(result.preview.recoverableTaskIds.length, 'recovered task')
              : null,
          ].filter(Boolean);
          toast.success(
            `Started ${formatCount(result.started.length, 'task')}`,
            descriptionParts.length > 0 ? { description: descriptionParts.join(' · ') } : undefined,
          );
        } else {
          toast('No ready work to start');
        }
      }
      return result;
    } catch (err) {
      notifyMutationError('Failed to start ready work:', err);
      return null;
    } finally {
      setStartReadyBusy(false);
    }
  }, [invoker, refreshActionGraph, refreshTaskGraph]);

  const handleStartReadyPreview = useCallback(async (
    mode: 'failed' | 'failedAndPending' | 'failedPendingAndRunning',
  ) => {
    if (!invoker?.startReady) return;
    setStartReadyBusy(true);
    setStartReadyMenuOpen(false);
    setStartReadyPreviewMode(mode);
    try {
      const result = await invoker.startReady(
        mode === 'failedPendingAndRunning'
          ? { dryRun: true, recreateFailedPendingAndRunning: true }
          : mode === 'failedAndPending'
            ? { dryRun: true, recreateFailedAndPending: true }
            : { dryRun: true, recreateFailed: true },
      );
      setStartReadyPreview(result);
    } catch (err) {
      notifyMutationError('Failed to preview ready work:', err);
    } finally {
      setStartReadyBusy(false);
    }
  }, [invoker]);

  const handleConfirmStartAndRecreateFailed = useCallback(async () => {
    const result = await handleStartReadyAction(
      startReadyPreviewMode === 'failedPendingAndRunning'
        ? { recreateFailedPendingAndRunning: true }
        : startReadyPreviewMode === 'failedAndPending'
          ? { recreateFailedAndPending: true }
          : { recreateFailed: true },
    );
    if (result) setStartReadyPreview(null);
  }, [handleStartReadyAction, startReadyPreviewMode]);

  const handlePlanningSubmitDraft = useCallback(async () => {
    if (activePlanningReadOnly) {
      return;
    }
    if (!planningSessionId) {
      setPlanningSubmitError({ title: 'Plan could not be submitted', message: 'No planning conversation yet.' });
      appendTerminalLine('Plan could not be submitted:\nNo planning conversation yet.', 'system', 'error');
      return;
    }
    if (!invoker?.planningChatSubmit) {
      setPlanningSubmitError({ title: 'Plan could not be submitted', message: 'Planner is not available.' });
      appendTerminalLine('Plan could not be submitted:\nPlanner is not available.', 'system', 'error');
      return;
    }
    updatePlanningSessionById(planningSessionId, (session) => ({ ...session, busy: true }));
    try {
      const result = await invoker.planningChatSubmit({ sessionId: planningSessionId });
      if (result.ok) {
        setPlanningSubmitError(null);
        setHasLoadedPlan(true);
        setWorkflowSelectionDismissed(false);
        setGraphActionsMenuOpen(false);
        setPlanName(result.planName);
        setSelectedWorkflowId(result.workflowId);
        issueCameraCommand({ kind: 'fitInitial', scope: 'workflow', reason: 'planning-submit' });
        updatePlanningSessionById(planningSessionId, (session) => ({
          ...session,
          busy: false,
          status: 'submitted',
          submittedWorkflowId: result.workflowId,
          submittedPlanName: result.planName,
          draftPlanAvailable: false,
          draftPlanSummary: undefined,
          updatedAt: new Date().toISOString(),
        }));
        await refreshTaskGraph();
        workflowGraphViewportRef.current = null;
        appendTerminalLine(
          result.workflowCount && result.workflowCount > 1
            ? `Plan "${result.planName}" submitted as ${result.workflowCount} stacked workflows. Review them, then use Start ready work.`
            : `Plan "${result.planName}" submitted to Invoker. Review it, then use Start ready work.`,
          'system',
          'success',
        );
      } else {
        updatePlanningSessionById(planningSessionId, (session) => ({ ...session, busy: false }));
        setPlanningSubmitError({ title: 'Plan could not be submitted', message: result.error });
        appendTerminalLine(`Plan could not be submitted:\n${result.error}`, 'system', 'error');
      }
    } catch (err) {
      updatePlanningSessionById(planningSessionId, (session) => ({ ...session, busy: false }));
      const message = err instanceof Error ? err.message : 'Failed to submit the plan.';
      setPlanningSubmitError({ title: 'Plan could not be submitted', message });
      appendTerminalLine(`Plan could not be submitted:\n${message}`, 'system', 'error');
    }
  }, [activePlanningReadOnly, appendTerminalLine, invoker, issueCameraCommand, planningSessionId, refreshTaskGraph, updatePlanningSessionById]);

  const handlePlanningSubmit = useCallback(async () => {
    const input = planningInput.trim();
    if (!input || activePlanningSessionBusy || activePlanningReadOnly) return;
    appendTerminalLine(input, 'user');
    setPlanningInput('');
    setPlanningSubmitError(null);

    if (input.toLowerCase() === 'run') {
      if (!hasLoadedPlan && tasks.size === 0 && workflows.size === 0) {
        appendTerminalLine(
          'Create or submit a plan before starting ready work.',
          'system',
          'error',
        );
        return;
      }
      updatePlanningSessionById(activePlanningSessionId, (session) => ({ ...session, busy: true }));
      try {
        const result = await handleStartReadyAction();
        if (result && !result.dryRun) {
          const startedCount = result.started.length;
          appendTerminalLine(
            startedCount > 0
              ? `Started ${startedCount} ready task${startedCount === 1 ? '' : 's'}.`
              : 'No ready work to start.',
            'system',
            startedCount > 0 ? 'success' : undefined,
          );
        }
      } finally {
        updatePlanningSessionById(activePlanningSessionId, (session) => ({ ...session, busy: false }));
      }
      return;
    }

    if (/^submit(\s+to\s+invoker)?[.!?]*$/i.test(input)) {
      await handlePlanningSubmitDraft();
      return;
    }

    if (!invoker?.planningChatSend) {
      appendTerminalLine('Planner is not available.', 'system', 'error');
      return;
    }

    const previousSessionId = activePlanningSessionId;
    pendingPlanningStreamSessionIdsRef.current.add(previousSessionId);
    clearPlanningStreamForSessionIds([previousSessionId, planningSessionId]);
    forgetPlanningStreamAliasesForSessionIds([previousSessionId, planningSessionId]);
    updatePlanningSessionById(previousSessionId, (session) => ({ ...session, busy: true }));
    try {
      const request = {
        message: input,
        presetKey: selectedPlanningPresetKey || undefined,
        ...(planningSessionId ? { sessionId: planningSessionId } : {}),
      };
      const result = await invoker.planningChatSend(request);
      if (result.ok) {
        const updatedAt = new Date().toISOString();
        const replyLineId = nextTerminalLineIdRef.current;
        nextTerminalLineIdRef.current += 1;
        setPlanningSessions((prev) => prev.map((session) => {
          if (session.id !== previousSessionId) return session;
          return {
            ...session,
            busy: false,
            id: result.sessionId,
            title: session.title === 'Untitled plan'
              ? (input.length > 56 ? `${input.slice(0, 53).trimEnd()}…` : input)
              : session.title,
            status: result.draftPlanAvailable ? 'draft_ready' : result.reply.includes('?') ? 'waiting_for_answer' : 'still_discussing',
            messages: [...session.messages, { id: replyLineId, text: result.reply, role: 'assistant', ...((result as { reasoning?: string }).reasoning ? { reasoning: (result as { reasoning?: string }).reasoning } : {}) }],
            draftPlanAvailable: result.draftPlanAvailable,
            draftPlanSummary: result.draftPlanAvailable ? result.draftPlanSummary : undefined,
            updatedAt,
          };
        }));
        setActivePlanningSessionId((currentSessionId) => (
          currentSessionId === previousSessionId ? result.sessionId : currentSessionId
        ));
        clearPlanningStreamForSessionIds([previousSessionId, result.sessionId]);
        forgetPlanningStreamAliasesForSessionIds([previousSessionId, result.sessionId]);
        pendingPlanningStreamSessionIdsRef.current.delete(previousSessionId);
        pendingPlanningStreamSessionIdsRef.current.delete(result.sessionId);
        setHasLoadedPlan(false);
      } else {
        updatePlanningSessionById(previousSessionId, (session) => ({ ...session, busy: false }));
        keepPlanningStreamFailureForSessionIds([previousSessionId, result.sessionId], result.error);
        forgetPlanningStreamAliasesForSessionIds([previousSessionId, result.sessionId]);
        pendingPlanningStreamSessionIdsRef.current.delete(previousSessionId);
        if (result.sessionId) pendingPlanningStreamSessionIdsRef.current.delete(result.sessionId);
        appendTerminalLine(result.error, 'system', 'error');
        setPlanningSubmitError({ title: 'Planner could not respond', message: result.error });
      }
    } catch (err) {
      updatePlanningSessionById(previousSessionId, (session) => ({ ...session, busy: false }));
      const message = err instanceof Error ? err.message : 'Failed to reach the planner.';
      keepPlanningStreamFailureForSessionIds([previousSessionId, planningSessionId], message);
      forgetPlanningStreamAliasesForSessionIds([previousSessionId, planningSessionId]);
      pendingPlanningStreamSessionIdsRef.current.delete(previousSessionId);
      if (planningSessionId) pendingPlanningStreamSessionIdsRef.current.delete(planningSessionId);
      setPlanningSubmitError({ title: 'Planner could not respond', message });
      appendTerminalLine(message, 'system', 'error');
    }
  }, [
    activePlanningSessionBusy,
    activePlanningSessionId,
    activePlanningReadOnly,
    appendTerminalLine,
    clearPlanningStreamForSessionIds,
    forgetPlanningStreamAliasesForSessionIds,
    handlePlanningSubmitDraft,
    handleStartReadyAction,
    hasLoadedPlan,
    keepPlanningStreamFailureForSessionIds,
    invoker,
    planningInput,
    planningSessionId,
    selectedPlanningPresetKey,
    setPlanningInput,
    tasks.size,
    updatePlanningSessionById,
    workflows.size,
  ]);

  const handleCreatePlanningSession = useCallback(() => {
    const index = nextPlanningSessionLocalIdRef.current;
    nextPlanningSessionLocalIdRef.current += 1;
    const now = new Date().toISOString();
    const localId = `local-planning-session-${index}`;
    const session: PlanningSessionView = {
      ...makeInitialPlanningSession(now),
      id: localId,
      conversationKey: localId,
      presetKey: selectedPlanningPresetKey,
    };
    setPlanningSessions((prev) => [session, ...prev]);
    setActivePlanningSessionId(session.id);
    setSidebarSurface('home');
    focusKeyboardRegion('planning');
  }, [focusKeyboardRegion, selectedPlanningPresetKey]);

  const handlePlanningModeChange = useCallback(async (mode: PlanningTerminalMode) => {
    const sourceSession = activePlanningSession;
    if (mode === 'chat') {
      updatePlanningSessionById(sourceSession.id, (session) => ({ ...session, mode: 'chat' }));
      if (!activePlanningReadOnly && !sourceSession.id.startsWith('local-')) {
        void invoker?.planningChatSetTerminalMode?.({ sessionId: sourceSession.id, mode: 'chat' });
      }
      return;
    }
    if (activePlanningReadOnly) {
      updatePlanningSessionById(sourceSession.id, (session) => ({
        ...session,
        mode: 'tmux',
        terminalBusy: false,
        terminalError: session.terminalSession ? null : 'No saved planning tmux session.',
      }));
      return;
    }
    if (sourceSession.mode === 'tmux' && (sourceSession.terminalBusy || sourceSession.terminalSession)) {
      return;
    }

    updatePlanningSessionById(sourceSession.id, (session) => ({
      ...session,
      mode: 'tmux',
      terminalBusy: !session.terminalSession,
      terminalError: null,
    }));

    let targetSessionId = sourceSession.id;
    let terminalSession = sourceSession.terminalSession ?? null;

    if (sourceSession.id.startsWith('local-')) {
      if (!invoker?.planningChatCreate) {
        updatePlanningSessionById(sourceSession.id, (session) => ({
          ...session,
          terminalBusy: false,
          terminalError: 'Planner is not available.',
        }));
        return;
      }

      try {
        const result = await invoker.planningChatCreate({
          presetKey: sourceSession.presetKey || selectedPlanningPresetKey || undefined,
          title: sourceSession.title,
        });
        if (!result.ok) {
          updatePlanningSessionById(sourceSession.id, (session) => ({
            ...session,
            terminalBusy: false,
            terminalError: result.error,
          }));
          return;
        }

        targetSessionId = result.session.id;
        terminalSession = null;
        setPlanningSessions((prev) => prev.map((session) => (
          session.id === sourceSession.id
            ? planningSessionFromSummary(result.session, {
                input: session.input,
                busy: false,
                mode: 'tmux',
                terminalBusy: true,
                terminalError: null,
              })
            : session
        )));
        setActivePlanningSessionId((currentSessionId) => (
          currentSessionId === sourceSession.id ? targetSessionId : currentSessionId
        ));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create a planning session.';
        updatePlanningSessionById(sourceSession.id, (session) => ({
          ...session,
          terminalBusy: false,
          terminalError: message,
        }));
        return;
      }
    }

    if (terminalSession) {
      updatePlanningSessionById(targetSessionId, (session) => ({
        ...session,
        mode: 'tmux',
        terminalBusy: false,
        terminalError: null,
      }));
      if (!targetSessionId.startsWith('local-')) {
        void invoker?.planningChatSetTerminalMode?.({ sessionId: targetSessionId, mode: 'tmux' });
      }
      return;
    }

    if (!invoker?.planningTerminalOpen) {
      updatePlanningSessionById(targetSessionId, (session) => ({
        ...session,
        terminalBusy: false,
        terminalError: 'Planning tmux is not available.',
      }));
      return;
    }

    try {
      const result = await invoker.planningTerminalOpen(targetSessionId);
      if (result.opened && result.session) {
        updatePlanningSessionById(targetSessionId, (session) => ({
          ...session,
          mode: 'tmux',
          terminalSession: result.session,
          terminalBusy: false,
          terminalError: null,
          updatedAt: new Date().toISOString(),
        }));
      } else {
        updatePlanningSessionById(targetSessionId, (session) => ({
          ...session,
          terminalBusy: false,
          terminalError: result.reason ?? 'Failed to open planning tmux.',
        }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to open planning tmux.';
      updatePlanningSessionById(targetSessionId, (session) => ({
        ...session,
        terminalBusy: false,
        terminalError: message,
      }));
    }
  }, [
    activePlanningReadOnly,
    activePlanningSession,
    invoker,
    selectedPlanningPresetKey,
    updatePlanningSessionById,
  ]);


  const handleClear = useCallback(async () => {
    if (!invoker) return;
    try {
      await invoker.clear();
      clearTasks();
      setHasLoadedPlan(false);
      setPlanName(null);
      setSidebarSurface('home');
      setSidebarCollapsed(false);
      setViewMode('dag');
      setGraphActionsMenuOpen(false);
      setSelectedTaskId(null);
      setSelectedWorkflowId(null);
      setModal({ type: 'none' });
      setStatusFilters(new Set<WorkflowStatus>());
    } catch (err) {
      notifyMutationError('Failed to clear:', err);
    }
  }, [clearTasks, invoker]);

  const handleDeleteDB = useCallback(async () => {
    if (!invoker) return;
    const confirmed = window.confirm(
      'Delete all workflow history from the database? This cannot be undone.',
    );
    if (!confirmed) return;
    try {
      await invoker.deleteAllWorkflowsBulk();
      clearTasks();
      setHasLoadedPlan(false);
      setPlanName(null);
      setSidebarSurface('home');
      setSidebarCollapsed(false);
      setViewMode('dag');
      setGraphActionsMenuOpen(false);
      setSelectedTaskId(null);
      setSelectedWorkflowId(null);
      setModal({ type: 'none' });
      setStatusFilters(new Set<WorkflowStatus>());
    } catch (err) {
      notifyMutationError('Failed to delete workflows:', err);
    }
  }, [clearTasks, invoker]);
  const showStartReadyControl = hasLoadedPlan || tasks.size > 0 || workflows.size > 0;
  const showEmptyPlanGraphCta = sidebarSurface === 'planning' && !hasLoadedPlan && tasks.size === 0 && workflows.size === 0;
  const setupIncomplete = Boolean(
    systemDiagnostics
    && (missingRequiredTool || needsBundledSkillsPrompt || installedAgentCount === 0),
  );
  const autoCollapseInspector = sidebarSurface !== 'planning' && viewportWidth < 1440;
  const effectiveInspectorCollapsed = inspectorCollapsed || (autoCollapseInspector && !inspectorManualOpen);
  const showWorkerDetailsPanel = viewMode === 'queue' && sidebarSurface === 'workers';
  const showInspectorPlaceholder = !showEmptyPlanGraphCta && !showWorkerDetailsPanel && !selectedTask && !selectedWorkflow && !(viewMode === 'actionGraph' && selectedActionNode);

  useEffect(() => {
    if (sidebarSurface === 'planning' || !autoCollapseInspector) {
      setInspectorManualOpen(false);
    }
  }, [autoCollapseInspector, sidebarSurface]);
  useEffect(() => {
    if (!graphActionsMenuOpen && !startReadyMenuOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (graphActionsMenuRef.current?.contains(event.target as Node)) return;
      if (startReadyMenuRef.current?.contains(event.target as Node)) return;
      setGraphActionsMenuOpen(false);
      setStartReadyMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setGraphActionsMenuOpen(false);
        setStartReadyMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [graphActionsMenuOpen, startReadyMenuOpen]);

  const selectViewMode = useCallback((nextView: 'dag' | 'history' | 'timeline' | 'queue' | 'actionGraph') => {
    setGraphActionsMenuOpen(false);
    reportUiNavigation(window.invoker?.reportUiPerf, {
      kind: 'viewMode',
      from: viewMode,
      to: nextView,
      sidebarSurface,
    });
    if (nextView !== 'actionGraph' && selectedActionNodeId !== null) {
      setSelectedActionNodeId(null);
    }
    if (nextView === 'actionGraph') {
      setSidebarSurface('planning');
      setViewMode('actionGraph');
      setWorkflowSelectionDismissed(true);
      setSelectedTaskId(null);
      return;
    }
    if (nextView === 'dag') {
      setViewMode('dag');
      return;
    }
    if (nextView === 'queue') {
      setSidebarSurface('workers');
      setInspectorCollapsed(true);
      setInspectorManualOpen(false);
    } else {
      // Timeline / history live on the plan-graph surface.
      setSidebarSurface('planning');
    }
    setViewMode(nextView);
  }, [selectedActionNodeId, sidebarSurface, viewMode]);

  const handleToggleInspectorCollapsed = useCallback(() => {
    if (autoCollapseInspector) {
      setInspectorCollapsed(false);
      setInspectorManualOpen((prev) => !prev);
      return;
    }
    setInspectorManualOpen(false);
    setInspectorCollapsed((prev) => !prev);
  }, [autoCollapseInspector]);

  const navigatePlanningHome = useCallback((_reason: string) => {
    setSidebarSurface('home');
    setInspectorManualOpen(false);
    setViewMode('dag');
    focusKeyboardRegion('planning');
  }, [focusKeyboardRegion]);

  const navigatePlanGraph = useCallback((reason: string, options: { fit: boolean }) => {
    setSidebarSurface('planning');
    setInspectorManualOpen(false);
    setViewMode('dag');
    focusKeyboardRegion('workflowGraph');

    if (options.fit) {
      workflowGraphViewportRef.current = null;
      issueCameraCommand({ kind: 'fitInitial', scope: 'workflow', reason });
      return;
    }

    setCameraCommand(null);
  }, [focusKeyboardRegion, issueCameraCommand]);

  const navigatePlanGraphAndFit = useCallback((reason: string) => {
    navigatePlanGraph(reason, { fit: true });
  }, [navigatePlanGraph]);

  const navigatePlanGraphPreservingViewport = useCallback((reason: string) => {
    navigatePlanGraph(reason, { fit: false });
  }, [navigatePlanGraph]);

  const handleSelectSidebarSurface = useCallback((nextSurface: SidebarSurface) => {
    setGraphActionsMenuOpen(false);
    reportUiNavigation(window.invoker?.reportUiPerf, {
      kind: 'sidebarSurface',
      from: sidebarSurface,
      to: nextSurface,
      viewMode,
    });
    if (nextSurface === 'workers') {
      setSidebarSurface('workers');
      setInspectorCollapsed(true);
      setInspectorManualOpen(false);
      setStatusFilters(new Set<WorkflowStatus>());
      setViewMode('dag');
      return;
    }
    if (nextSurface === 'home') {
      navigatePlanningHome('sidebar-home');
      return;
    }
    if (nextSurface === 'planning') {
      if (sidebarSurface === 'home') {
        navigatePlanGraphPreservingViewport('sidebar-planning');
        return;
      }
      navigatePlanGraphAndFit('sidebar-planning');
      return;
    }
    setViewMode('dag');
    setSidebarSurface(nextSurface);
    setInspectorManualOpen(false);
    setStatusFilters(new Set<WorkflowStatus>());
  }, [navigatePlanGraphAndFit, navigatePlanGraphPreservingViewport, navigatePlanningHome, sidebarSurface, viewMode]);

  const handleDismissBrowserSurface = useCallback(() => {
    setGraphActionsMenuOpen(false);
    reportUiNavigation(window.invoker?.reportUiPerf, {
      kind: 'sidebarSurface',
      from: sidebarSurface,
      to: 'home',
      viewMode,
      dismiss: true,
    });
    navigatePlanningHome('browser-return-home');
  }, [navigatePlanningHome, sidebarSurface, viewMode]);

  // ── Task actions ──────────────────────────────────────────
  const handleProvideInput = useCallback(
    async (taskId: string, input: string) => {
      if (!invoker) return;
      const result = await invoker.provideInput(taskId, input);
      trackAcceptedMutation(result);
    },
    [invoker, trackAcceptedMutation],
  );

  const handleApprove = useCallback(
    async (taskId: string) => {
      if (!invoker) return;
      const result = await invoker.approve(taskId);
      trackAcceptedMutation(result);
    },
    [invoker, trackAcceptedMutation],
  );

  const handleReject = useCallback(
    async (taskId: string, reason?: string) => {
      if (!invoker) return;
      const result = await invoker.reject(taskId, reason);
      trackAcceptedMutation(result);
    },
    [invoker, trackAcceptedMutation],
  );

  const handleSelectExperiment = useCallback(
    async (taskId: string, experimentIds: string[]) => {
      if (!invoker) return;
      const result = await invoker.selectExperiment(taskId, experimentIds.length === 1 ? experimentIds[0] : experimentIds);
      trackAcceptedMutation(result);
    },
    [invoker, trackAcceptedMutation],
  );

  // ── Edit task command ──────────────────────────────────────
  const handleEditCommand = useCallback(
    async (taskId: string, newCommand: string) => {
      if (!invoker) return;
      try {
        const result = await invoker.editTaskCommand(taskId, newCommand);
        trackAcceptedMutation(result);
      } catch (err) {
        notifyMutationError('Failed to edit task command:', err);
      }
    },
    [invoker, trackAcceptedMutation],
  );

  // ── Edit task prompt ───────────────────────────────────────
  const handleEditPrompt = useCallback(
    async (taskId: string, newPrompt: string) => {
      if (!invoker) return;
      try {
        const result = await invoker.editTaskPrompt(taskId, newPrompt);
        trackAcceptedMutation(result);
      } catch (err) {
        notifyMutationError('Failed to edit task prompt:', err);
      }
    },
    [invoker, trackAcceptedMutation],
  );

  // ── Edit task executor type ───────────────────────────────
  const handleEditType = useCallback(
    async (taskId: string, runnerKind: string, poolMemberId?: string) => {
      if (!invoker) return;
      try {
        const result = await invoker.editTaskType(taskId, runnerKind, poolMemberId);
        trackAcceptedMutation(result);
      } catch (err) {
        notifyMutationError('Failed to edit task type:', err);
      }
    },
    [invoker, trackAcceptedMutation],
  );

  // ── Edit task execution pool ─────────────────────────────
  const handleEditPool = useCallback(
    async (taskId: string, poolId: string) => {
      if (!invoker) return;
      try {
        const result = await invoker.editTaskPool(taskId, poolId);
        trackAcceptedMutation(result);
      } catch (err) {
        notifyMutationError('Failed to edit task pool:', err);
      }
    },
    [invoker, trackAcceptedMutation],
  );

  // ── Edit task execution agent ────────────────────────────
  const handleEditAgent = useCallback(
    async (taskId: string, agentName: string) => {
      if (!invoker) return;
      try {
        const result = await invoker.editTaskAgent(taskId, agentName);
        trackAcceptedMutation(result);
      } catch (err) {
        notifyMutationError('Failed to edit task agent:', err);
      }
    },
    [invoker, trackAcceptedMutation],
  );
  const handleEditModel = useCallback(
    async (taskId: string, executionModel: string | null) => {
      if (!invoker) return;
      try {
        const result = await invoker.editTaskModel(taskId, executionModel);
        trackAcceptedMutation(result);
      } catch (err) {
        notifyMutationError('Failed to edit task model:', err);
      }
    },
    [invoker, trackAcceptedMutation],
  );

  const handleSetExternalGatePolicies = useCallback(
    async (taskId: string, updates: ExternalGatePolicyUpdate[]) => {
      if (!invoker) return;
      try {
        const result = await invoker.setTaskExternalGatePolicies(taskId, updates);
        trackAcceptedMutation(result);
      } catch (err) {
        notifyMutationError('Failed to set external gate policies:', err);
      }
    },
    [invoker, trackAcceptedMutation],
  );

  const handleSetMergeBranch = useCallback(
    async (workflowId: string, baseBranch: string) => {
      if (!invoker) return;
      try {
        const result = await invoker.setMergeBranch(workflowId, baseBranch);
        trackAcceptedMutation(result);
      } catch (err) {
        notifyMutationError('Failed to set merge branch:', err);
      }
    },
    [invoker, trackAcceptedMutation],
  );

  const handleSetMergeMode = useCallback(
    async (workflowId: string, mergeMode: 'manual' | 'automatic' | 'external_review') => {
      if (!invoker) return;
      try {
        const result = await invoker.setMergeMode(workflowId, mergeMode);
        trackAcceptedMutation(result);
      } catch (err) {
        notifyMutationError('Failed to set merge mode:', err);
      }
    },
    [invoker, trackAcceptedMutation],
  );

  // ── Modal triggers ────────────────────────────────────────
  const openInputModal = useCallback((task: TaskState) => {
    setModal({ type: 'input', task });
  }, []);

  const openApprovalModal = useCallback((task: TaskState) => {
    setModal({ type: 'approval', task, action: 'approve' });
  }, []);

  const openRejectModal = useCallback((task: TaskState) => {
    setModal({ type: 'approval', task, action: 'reject' });
  }, []);

  const openExperimentModal = useCallback((task: TaskState) => {
    setModal({ type: 'experiment', task });
  }, []);

  const closeModal = useCallback(() => {
    setModal({ type: 'none' });
  }, []);

  const handleInstallBundledSkills = useCallback(async (mode: 'install' | 'update' | 'reinstall' = 'install') => {
    try {
      setInstallSkillsPending(true);
      setInstallSkillsError(null);
      const diagnostics = await window.invoker?.installBundledSkills?.(mode);
      if (diagnostics) {
        setSystemDiagnostics((prev) => prev ? { ...prev, bundledSkills: diagnostics } : prev);
      }
      refreshSystemDiagnostics();
    } catch (err) {
      setInstallSkillsError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallSkillsPending(false);
    }
  }, [refreshSystemDiagnostics]);

  const handleUpdateInvokerCli = useCallback(async () => {
    try {
      setUpdateCliPending(true);
      setUpdateCliError(null);
      const result = await window.invoker?.updateInvokerCli?.();
      if (result && !result.ok) {
        setUpdateCliError(result.error ?? 'invoker-cli update failed.');
      }
      refreshSystemDiagnostics();
    } catch (err) {
      setUpdateCliError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdateCliPending(false);
    }
  }, [refreshSystemDiagnostics]);
  const handleRunInvokerCliSetup = useCallback(async (request: InvokerSetupRequest) => {
    try {
      setSetupPending(true);
      setSetupResult(null);
      const result = await window.invoker?.runInvokerCliSetup?.(request);
      setSetupResult(result ?? {
        ok: false,
        steps: [{ id: 'tools', name: 'Run setup', ok: false, output: '', error: 'invoker-cli setup is not available.' }],
      });
      refreshSystemDiagnostics();
    } catch (err) {
      setSetupResult({
        ok: false,
        steps: [{ id: 'tools', name: 'Run setup', ok: false, output: '', error: err instanceof Error ? err.message : String(err) }],
      });
    } finally {
      setSetupPending(false);
    }
  }, [refreshSystemDiagnostics]);


  const selectedWorkflowEntry = selectedWorkflow
    ? workflowEntries.find((entry) => entry.workflow.id === selectedWorkflow.id) ?? null
    : null;
  const selectedTaskWorkflowName = selectedWorkflow?.name ?? (selectedTask?.config.workflowId ? workflows.get(selectedTask.config.workflowId)?.name ?? selectedTask.config.workflowId : null);

  const renderGraphActions = (showMoreMenu: boolean): JSX.Element => (
    <div className="flex items-center gap-2">
      {showStartReadyControl && (
        <div ref={startReadyMenuRef} className="relative inline-flex">
          <button
            type="button"
            data-testid="rail-start-ready"
            onClick={() => void handleStartReadyAction()}
            disabled={startReadyBusy}
            className="inline-flex h-8 items-center gap-1.5 rounded-l border border-emerald-600 bg-emerald-700 px-3 text-xs font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <PlayIcon className="h-3.5 w-3.5" />
            {startReadyBusy ? 'Starting…' : 'Start ready work'}
          </button>
          <button
            type="button"
            aria-label="Start ready options"
            aria-expanded={startReadyMenuOpen}
            data-testid="rail-start-ready-menu"
            onClick={() => setStartReadyMenuOpen((open) => !open)}
            disabled={startReadyBusy}
            className="inline-flex h-8 w-8 items-center justify-center rounded-r border-y border-r border-emerald-600 bg-emerald-800 text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <ChevronDownIcon className="h-3.5 w-3.5" />
          </button>
          {startReadyMenuOpen && (
            <div
              data-testid="rail-start-ready-options"
              className="absolute right-0 top-10 z-30 w-56 rounded-lg border border-border bg-card p-1 shadow-xl"
            >
              <button
                type="button"
                data-testid="rail-start-ready-recreate-failed"
                onClick={() => void handleStartReadyPreview('failed')}
                className="block w-full rounded px-3 py-2 text-left text-xs text-foreground hover:bg-secondary"
              >
                Start and recreate failed…
              </button>
              <button
                type="button"
                data-testid="rail-start-ready-recreate-failed-and-pending"
                onClick={() => void handleStartReadyPreview('failedAndPending')}
                className="block w-full rounded px-3 py-2 text-left text-xs text-foreground hover:bg-secondary"
              >
                Start and recreate failed and pending…
              </button>
              <button
                type="button"
                data-testid="rail-start-ready-recreate-failed-pending-and-running"
                onClick={() => void handleStartReadyPreview('failedPendingAndRunning')}
                className="block w-full rounded px-3 py-2 text-left text-xs text-foreground hover:bg-secondary"
              >
                Start and recreate failed, pending, and running…
              </button>
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        data-testid="rail-refresh"
        onClick={handleRefresh}
        className="rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
      >
        Refresh
      </button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setGraphMaximized(true)}
      >
        Full graph ⤢
      </Button>
      {showMoreMenu && (
        <div ref={graphActionsMenuRef} className="relative z-[1200]">
          <button
            type="button"
            data-testid="graph-more-button"
            onClick={() => setGraphActionsMenuOpen((open) => !open)}
            className="rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
          >
            More ▾
          </button>
          {graphActionsMenuOpen && (
            <div
              data-testid="graph-more-menu"
              className="absolute right-0 top-10 z-[1200] w-48 rounded-lg border border-border bg-card p-1 shadow-xl"
            >
              <button
                type="button"
                data-testid="rail-home"
                onClick={() => {
                  handleSelectSidebarSurface('planning');
                  selectViewMode('dag');
                }}
                className="block w-full rounded px-3 py-2 text-left text-xs text-foreground hover:bg-secondary"
              >
                Plan graph
              </button>
              <button
                type="button"
                data-testid="rail-planning-home"
                onClick={() => {
                  handleSelectSidebarSurface('home');
                }}
                className="block w-full rounded px-3 py-2 text-left text-xs text-foreground hover:bg-secondary"
              >
                Planning home
              </button>
              <button
                type="button"
                data-testid="rail-timeline"
                onClick={() => selectViewMode('timeline')}
                className="block w-full rounded px-3 py-2 text-left text-xs text-foreground hover:bg-secondary"
              >
                Timeline
              </button>
              <button
                type="button"
                data-testid="rail-history"
                onClick={() => selectViewMode('history')}
                className="block w-full rounded px-3 py-2 text-left text-xs text-foreground hover:bg-secondary"
              >
                History
              </button>
              <button
                type="button"
                data-testid="rail-action-graph"
                onClick={() => selectViewMode('actionGraph')}
                className="block w-full rounded px-3 py-2 text-left text-xs text-foreground hover:bg-secondary"
              >
                Action Graph
              </button>
              <button
                type="button"
                data-testid="rail-queue"
                onClick={() => selectViewMode('queue')}
                className="block w-full rounded px-3 py-2 text-left text-xs text-foreground hover:bg-secondary"
              >
                Queue
              </button>
              <div className="my-1 border-t border-border" />
              <button
                type="button"
                data-testid="rail-clear"
                onClick={async () => {
                  setGraphActionsMenuOpen(false);
                  await handleClear();
                }}
                className="block w-full rounded px-3 py-2 text-left text-xs text-foreground hover:bg-secondary"
              >
                Clear
              </button>
              <button
                type="button"
                data-testid="rail-delete-history"
                onClick={async () => {
                  setGraphActionsMenuOpen(false);
                  await handleDeleteDB();
                }}
                className="block w-full rounded px-3 py-2 text-left text-xs text-red-300 hover:bg-red-950/50"
              >
                Delete history
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  const renderSelectedWorkflowTaskGraph = (floating: boolean): JSX.Element | null => {
    if (displayedSelectedWorkflowGraph === null) return null;

    const graphBody = (
      <div
        data-keyboard-region="taskGraph"
        tabIndex={0}
        data-keyboard-active={keyboardRegion === 'taskGraph' ? 'true' : 'false'}
        className={`flex h-full min-h-0 flex-1 outline-none ${keyboardRegion === 'taskGraph' ? 'ring-2 ring-inset ring-ring/60' : ''}`}
      >
        {isSelectedWorkflowGraphRefreshing && (
          <div data-testid="selected-workflow-mini-dag-refreshing" className="px-2 py-1 text-xs text-amber-200">
            Refreshing graph…
          </div>
        )}
        <TaskDAG
          key={`${displayedSelectedWorkflowGraph.workflow.id}-${floating ? 'floating' : 'browser'}`}
          tasks={displayedSelectedWorkflowGraph.tasks}
          workflows={selectedTaskDagWorkflows}
          selectedTaskId={selectedTaskId}
          cameraCommand={cameraCommand}
          onTaskClick={handleTaskClick}
          onTaskDoubleClick={handleTaskDoubleClick}
          onTaskContextMenu={handleTaskContextMenu}
          statusFilters={new Set<string>()}
          runningTaskIds={runningTaskIds}
          surfaceMode={floating ? 'default' : 'browser'}
        />
      </div>
    );

    if (floating) {
      return (
        <FloatingGraphPanel
          key={displayedSelectedWorkflowGraph.workflow.id}
          testId="selected-workflow-mini-dag"
          dragHandleTestId="selected-workflow-mini-dag-drag-handle"
          title={`${displayedSelectedWorkflowGraph.workflow.name} task DAG`}
          boundsRef={graphSurfaceRef as unknown as RefObject<HTMLElement>}
          contentClassName="min-h-0 h-[180px] overflow-hidden"
        >
          {graphBody}
        </FloatingGraphPanel>
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col p-4">
        <div
          data-testid="selected-workflow-mini-dag"
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-border bg-background/95 shadow-lg"
        >
          <div className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
            {displayedSelectedWorkflowGraph.workflow.name} task DAG
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            {graphBody}
          </div>
        </div>
      </div>
    );
  };

  const renderGraphCanvas = (): JSX.Element => (
    <div
      ref={graphSurfaceRef}
      data-testid="workflow-graph-surface"
      data-keyboard-region="workflowGraph"
      tabIndex={0}
      data-keyboard-active={keyboardRegion === 'workflowGraph' ? 'true' : 'false'}
      className={`relative isolate z-0 min-h-0 flex-1 overflow-hidden border-r border-border bg-background outline-none ${keyboardRegion === 'workflowGraph' ? 'ring-2 ring-inset ring-ring/50' : ''}`}
      onClick={viewMode === 'dag' ? handleDagSurfaceClick : undefined}
    >
      {viewMode === 'queue' ? (
        <QueueView
          tasks={tasks}
          workflows={workflows}
          queueStatus={queueStatus}
          workerStatus={workerStatus}
          readOnly={runtimeStatus?.readOnly === true}
          onStartWorker={handleStartWorker}
          onStopWorker={handleStopWorker}
          onTaskClick={handleTaskClick}
          selectedTaskId={selectedTaskId}
          selectedWorkerKind={selectedWorkerKind}
          onSelectWorker={setSelectedWorkerKind}
        />
      ) : viewMode === 'history' ? (
        <HistoryView onTaskClick={handleTaskClick} selectedTaskId={selectedTaskId} />
      ) : viewMode === 'timeline' ? (
        <TimelineView
          tasks={tasks}
          workflows={workflows}
          selectedWorkflowId={selectedWorkflowId}
          onTaskClick={handleTaskClick}
          selectedTaskId={selectedTaskId}
        />
      ) : viewMode === 'actionGraph' ? (
        <ActionGraphView
          graph={actionGraph}
          error={actionGraphError}
          selectedNodeId={selectedActionNodeId}
          onSelectNode={(node) => {
            setSelectedActionNodeId(node?.id ?? null);
            if (node?.taskId) setSelectedTaskId(node.taskId);
            if (node?.workflowId) setSelectedWorkflowId(node.workflowId);
          }}
        />
      ) : (
        <>
          {sidebarSurface === 'planning' && (
            <div data-testid="workflow-graph-content" className="relative z-0 h-full w-full">
              <WorkflowGraph
                workflows={workflows}
                selectedWorkflowId={selectedWorkflow?.id ?? null}
                cameraCommand={cameraCommand}
                initialViewport={workflowGraphViewportRef.current}
                statusFilters={statusFilters}
                coreActivityByWorkflow={coreActivityByWorkflow}
                onSelectWorkflow={handleWorkflowClick}
                onWorkflowContextMenu={handleWorkflowContextMenu}
                onViewportSnapshot={handleWorkflowGraphViewportSnapshot}
              />
            </div>
          )}
          {renderSelectedWorkflowTaskGraph(sidebarSurface === 'planning')}
        </>
      )}
    </div>
  );

  const renderGraphWorkspace = (title: string, subtitle: string, showMoreMenu: boolean): JSX.Element => (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-card/50 px-4 py-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        {renderGraphActions(showMoreMenu)}
      </div>
      {renderGraphCanvas()}
    </div>
  );

  const renderBrowserEmptyState = (title: string, copy: string): JSX.Element => (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div>
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-2 text-sm text-muted-foreground">{copy}</div>
      </div>
    </div>
  );

  const workflowsSubtitle = `${workflowEntries.length} workflow${workflowEntries.length === 1 ? '' : 's'}`;
  const attentionSubtitle = attentionEntries.length === 0
    ? 'Nothing needs a decision right now.'
    : `${attentionEntries.length} item${attentionEntries.length === 1 ? '' : 's'} need attention.`;
  const browserSurfaceTitle = sidebarSurface === 'workflows' ? 'Workflows' : 'Needs Attention';
  const browserSurfaceSubtitle = sidebarSurface === 'workflows' ? workflowsSubtitle : attentionSubtitle;

  const browserSelectedTitle = sidebarSurface === 'workflows'
    ? selectedWorkflow?.name ?? 'Select a workflow'
    : selectedTask?.description || selectedTask?.id || 'Select an item';
  const browserSelectedContext = sidebarSurface === 'workflows'
    ? selectedWorkflowEntry
      ? `${selectedWorkflowEntry.taskCount} task${selectedWorkflowEntry.taskCount === 1 ? '' : 's'}`
      : workflowsSubtitle
    : selectedTaskWorkflowName ?? 'No workflow';
  const browserSelectedStatus = sidebarSurface === 'workflows'
    ? selectedWorkflow
      ? formatWorkflowStatus(selectedWorkflow.status)
      : 'No workflow selected'
    : selectedTask
      ? formatTaskStatus(selectedTask.status)
      : 'No item selected';
  const browserStatusToneClass = sidebarSurface === 'attention'
    ? 'bg-amber-950/70 text-amber-100'
    : 'bg-secondary text-foreground';

  const relatedBrowserTasks = Array.from(miniDagTasks.values()).filter((task) =>
    sidebarSurface === 'workflows' || task.id !== selectedTask?.id,
  );

  const renderWorkflowsList = (): JSX.Element => (
    workflowEntries.length === 0 ? renderBrowserEmptyState('No workflows yet', 'Go to Home to draft your first plan.') : (
      <div data-testid="workflows-rail-list" className={`${RAIL_SCROLL_BODY_CLASS} p-3`}>
        <div className="space-y-1">
          {workflowEntries.map((entry) => (
            <BrowserWorkflowRow
              key={entry.workflow.id}
              workflowId={entry.workflow.id}
              name={entry.workflow.name}
              taskCount={entry.taskCount}
              statusLabel={formatWorkflowStatus(entry.workflow.status)}
              selected={selectedWorkflow?.id === entry.workflow.id}
              onSelect={selectWorkflowById}
            />
          ))}
        </div>
      </div>
    )
  );

  const renderTaskList = (entries: typeof attentionEntries, emptyTitle: string, emptyCopy: string): JSX.Element => (
    entries.length === 0 ? renderBrowserEmptyState(emptyTitle, emptyCopy) : (
      <div data-testid="attention-rail-list" className={`${RAIL_SCROLL_BODY_CLASS} p-3`}>
        <div className="space-y-1">
          {entries.map((entry) => (
            <BrowserTaskRow
              key={entry.task.id}
              taskId={entry.task.id}
              title={entry.task.description || entry.task.id}
              workflowName={entry.workflow?.name}
              statusLabel={formatTaskStatus(entry.task.status)}
              tone="attention"
              selected={selectedTaskId === entry.task.id}
              onSelect={selectTaskById}
            />
          ))}
        </div>
      </div>
    )
  );

  const renderWorkerActionEntry = (action: WorkerActionSummary): JSX.Element => (
    <div key={action.id} className="rounded-lg border border-gray-800 bg-gray-850/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-gray-100">{formatWorkerValue(action.actionType)}</div>
        <span className="rounded-full border border-gray-700 bg-gray-800 px-2 py-0.5 text-[11px] text-gray-200">
          {formatWorkerValue(action.status)}
        </span>
      </div>
      <div className="mt-1 text-xs text-gray-500">{workerActionTarget(action)}</div>
      {action.summary ? <div className="mt-2 text-sm text-gray-300">{action.summary}</div> : null}
      <div className="mt-2 text-[11px] text-gray-500">Updated {action.updatedAt}</div>
    </div>
  );

  const renderWorkerLogEntry = (log: WorkerLogEntry): JSX.Element => (
    <div key={log.id} className="rounded-lg border border-gray-800 bg-gray-850/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-gray-100">{workerLogTitle(log)}</div>
        {log.status ? (
          <span className="rounded-full border border-gray-700 bg-gray-800 px-2 py-0.5 text-[11px] text-gray-200">
            {formatWorkerValue(log.status)}
          </span>
        ) : null}
      </div>
      <div className="mt-1 text-xs text-gray-500">{workerLogTarget(log)}</div>
      {log.summary ? <div className="mt-2 text-sm text-gray-300">{log.summary}</div> : null}
      <div className="mt-2 text-[11px] text-gray-500">Logged {log.createdAt}</div>
    </div>
  );

  const renderWorkersDetail = (): JSX.Element => {
    if (!selectedWorker) {
      return renderBrowserEmptyState('No workers found', 'Invoker has not returned any worker registry rows yet.');
    }

    const copy = getWorkerDisplayCopy(selectedWorker.kind);
    const activeAction = getActiveWorkerAction(selectedWorker);
    const recentLogs = selectedWorker.recentLogs ?? [];
    const hasResponseHistory = selectedWorker.recentActions.length > 0 || recentLogs.length > 0;

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-gray-800 bg-gray-950/50 px-4 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-100">{copy.name}</h2>
              <p className="mt-1 text-sm text-gray-400">{selectedWorker.note || 'Worker registry entry'}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-gray-700 bg-gray-800 px-2.5 py-1 text-[11px] font-medium text-gray-200">
                  Kind: {selectedWorker.kind}
                </span>
                <span className="rounded-full border border-gray-700 bg-gray-800 px-2.5 py-1 text-[11px] font-medium text-gray-200">
                  Source: {formatWorkerValue(selectedWorker.source)}
                </span>
                <span className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-[11px] font-medium text-cyan-100">
                  State: {workerStateLabel(selectedWorker)}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <WorkerDetailControl
                worker={selectedWorker}
                readOnly={runtimeStatus?.readOnly === true}
                onStartWorker={handleStartWorker}
                onStopWorker={handleStopWorker}
              />
              <button
                type="button"
                aria-label="Return home"
                data-testid="workers-return-home"
                onClick={handleDismissBrowserSurface}
                className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
              >
                Home
              </button>
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <section className="rounded-xl border border-gray-800 bg-gray-900/80 p-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Registry</h3>
              <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="text-gray-500">Kind</dt>
                <dd className="text-gray-200">{selectedWorker.kind}</dd>
                <dt className="text-gray-500">Note</dt>
                <dd className="text-gray-200">{selectedWorker.note || 'No note'}</dd>
                <dt className="text-gray-500">Source</dt>
                <dd className="text-gray-200">{formatWorkerValue(selectedWorker.source)}</dd>
                <dt className="text-gray-500">Availability</dt>
                <dd className="text-gray-200">{formatWorkerValue(selectedWorker.availability)}</dd>
                <dt className="text-gray-500">Policy</dt>
                <dd className="text-gray-200">{formatWorkerValue(selectedWorker.policy)}{selectedWorker.policyReason ? ` · ${selectedWorker.policyReason}` : ''}</dd>
                <dt className="text-gray-500">Runtime</dt>
                <dd className="text-gray-200">{selectedWorker.runtimeKind ?? 'Not running'}</dd>
              </dl>
            </section>
            <section className="rounded-xl border border-gray-800 bg-gray-900/80 p-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Current state</h3>
              <div className="mt-3 text-sm text-gray-300">
                Process is {formatWorkerValue(selectedWorker.lifecycle)}.
                {activeAction ? ` Current response is ${formatWorkerValue(activeAction.actionType)} (${formatWorkerValue(activeAction.status)}).` : ' No response is running.'}
              </div>
              {selectedWorker.lastError ? <div className="mt-3 rounded border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-100">{selectedWorker.lastError}</div> : null}
            </section>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <section className="rounded-xl border border-gray-800 bg-gray-900/80 p-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Latest responses</h3>
              <div className="mt-3 space-y-2">
                {selectedWorker.recentActions.length > 0
                  ? selectedWorker.recentActions.slice(0, 5).map(renderWorkerActionEntry)
                  : <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-3 text-sm text-gray-400">No worker responses have been logged yet.</div>}
              </div>
            </section>
            <section className="rounded-xl border border-gray-800 bg-gray-900/80 p-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Latest logs</h3>
              <div className="mt-3 space-y-2">
                {recentLogs.length > 0
                  ? recentLogs.slice(0, 5).map(renderWorkerLogEntry)
                  : <div className="rounded-lg border border-gray-800 bg-gray-950/60 p-3 text-sm text-gray-400">No worker responses have been logged yet.</div>}
              </div>
            </section>
          </div>

          {!hasResponseHistory ? (
            <div className="mt-4 rounded-xl border border-gray-800 bg-gray-950/60 p-4 text-sm text-gray-400">
              No worker responses have been logged yet.
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  const workersSubtitle = workerStatus === null
    ? 'Worker status is not available yet.'
    : `${workerStatus.workers.length} worker${workerStatus.workers.length === 1 ? '' : 's'} registered.`;

  const renderWorkersSurface = (): JSX.Element => (
    <div className="flex-1 flex overflow-hidden">
      <div data-testid="workers-rail" className="flex h-full w-80 shrink-0 flex-col border-r border-gray-800 bg-gray-950/45">
        <div className="flex items-start justify-between gap-3 border-b border-gray-800 px-4 py-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-100">Workers</h2>
            <p className="mt-1 text-xs text-gray-500">{workersSubtitle}</p>
          </div>
          <button
            type="button"
            aria-label="Close workers panel"
            data-testid="workers-rail-dismiss"
            onClick={handleDismissBrowserSurface}
            className="rounded-lg border border-gray-700 px-2 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
          >
            Close
          </button>
        </div>
        <section data-testid="worker-processes-section" className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div data-testid="worker-process-scroll" className="min-h-0 flex-1 overflow-y-auto p-4">
            <WorkerActivityCard
              snapshot={workerStatus}
              selectedWorkerKind={selectedWorkerKind}
              onSelectWorker={setSelectedWorkerKind}
              showControls={false}
            />
          </div>
        </section>
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        {renderWorkersDetail()}
      </div>
    </div>
  );


  const renderPlanningSessionList = (): JSX.Element => (
    <div data-testid="planning-session-list" className={`${RAIL_SCROLL_BODY_CLASS} py-1`}>
      <div className="space-y-0.5">
        {planningSessions.map((session) => {
          const selected = session.id === activePlanningSession.id;
          const preview = previewPlanningMessage(session);
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => setActivePlanningSessionId(session.id)}
              className={`flex w-full items-start gap-2 border-l-2 px-3 py-2 text-left transition-colors ${selected ? 'border-l-foreground bg-accent/40 text-accent-foreground' : 'border-l-transparent text-foreground hover:bg-accent/20'}`}
            >
              <PlanningSessionStatusIcon busy={session.busy} status={session.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-medium leading-5" title={session.title}>
                    {session.title}
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {relativePlanningUpdatedAt(session.updatedAt)}
                  </span>
                </div>
                <div
                  className="mt-1 line-clamp-3 break-words text-[11px] leading-4 text-muted-foreground"
                  title={preview}
                >
                  {preview}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );

  const planningReadyCount = planningSessions.filter((session) => session.status === 'draft_ready').length;
  const connectedAgentLabels = (systemDiagnostics?.tools ?? [])
    .filter((tool) => (tool.id === 'claude' || tool.id === 'codex') && tool.installed)
    .map((tool) => tool.name.replace(/\s+CLI$/i, ''));

  const renderPlanningContextPanel = (): JSX.Element => (
    <aside
      data-testid="planning-context-panel"
      className={`${planningContextCollapsed ? 'w-16' : 'w-72'} shrink-0 border-l border-border bg-card/60 transition-all duration-150`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        {!planningContextCollapsed && (
          <h2 className="text-sm font-semibold text-foreground">Current plan</h2>
        )}
        <button
          type="button"
          data-testid="planning-context-toggle"
          aria-label={planningContextCollapsed ? 'Expand current plan' : 'Collapse current plan'}
          onClick={() => setPlanningContextCollapsed((value) => !value)}
          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-secondary"
        >
          {planningContextCollapsed ? '›' : '‹'}
        </button>
      </div>
      {!planningContextCollapsed && (
        <div className="space-y-4 p-4 text-sm">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Goal</div>
            <p className="mt-1 text-foreground">
              {activePlanningSession.title === 'Untitled plan'
                ? 'Describe a goal in the chat to begin drafting.'
                : activePlanningSession.title}
            </p>
          </div>
          {draftPlanSummary && (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Draft</div>
              <p className="mt-1 text-foreground">
                {draftPlanSummary.name} · {draftPlanSummary.taskCount} task{draftPlanSummary.taskCount === 1 ? '' : 's'}
              </p>
            </div>
          )}
          {activePlanningSession.submittedPlanName && (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Submitted</div>
              <p className="mt-1 text-foreground">{activePlanningSession.submittedPlanName}</p>
            </div>
          )}
          {(draftPlanAvailable || activePlanningSession.status === 'submitted') && (
            <button
              type="button"
              data-testid="planning-context-open-graph"
              onClick={() => navigatePlanGraphAndFit('planning-context')}
              className="w-full rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-secondary"
            >
              Open graph
            </button>
          )}
        </div>
      )}
    </aside>
  );

  const renderPlanningTerminalSurface = (): JSX.Element => (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div
        data-testid="planning-session-rail"
        className={`flex h-full shrink-0 flex-col border-r border-border bg-card transition-all duration-150 ${planningSessionRailCollapsed ? 'w-16' : 'w-64'}`}
      >
        {planningSessionRailCollapsed ? (
          <div className="flex flex-col items-center gap-2 px-2 py-2.5">
            <button
              type="button"
              aria-label="New chat"
              onClick={handleCreatePlanningSession}
              className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-secondary"
            >
              +
            </button>
            <button
              type="button"
              data-testid="planning-session-rail-toggle"
              aria-label="Expand planning chats"
              onClick={() => setPlanningSessionRailCollapsed(false)}
              className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-secondary"
            >
              ›
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5">
              <div className="min-w-0">
                <h2 className="text-sm font-medium text-foreground">Planning</h2>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {planningSessions.length} chat{planningSessions.length === 1 ? '' : 's'}
                  {planningReadyCount > 0 ? ` · ${planningReadyCount} ready` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={handleCreatePlanningSession}>
                  New chat
                </Button>
                <button
                  type="button"
                  data-testid="planning-session-rail-toggle"
                  aria-label="Collapse planning chats"
                  onClick={() => setPlanningSessionRailCollapsed(true)}
                  className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-secondary"
                >
                  ‹
                </button>
              </div>
            </div>
            <div className={RAIL_LIST_FRAME_CLASS}>{renderPlanningSessionList()}</div>
          </>
        )}
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        data-keyboard-region="planning"
        tabIndex={0}
        data-keyboard-active={keyboardRegion === 'planning' ? 'true' : 'false'}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-2.5">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-foreground">Planning chat</h2>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{activePlanningSession.title}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-muted-foreground">
              {planningSessionStatusLabel(activePlanningSession)}
            </span>
            {setupIncomplete && (
              <button
                type="button"
                data-testid="planning-finish-setup"
                onClick={() => {
                  cancelPendingSystemSetupAutoOpen();
                  setShowSystemSetup(true);
                }}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-foreground hover:bg-secondary"
              >
                Finish setup
              </button>
            )}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden bg-background">
          <InvokerTerminal
            activeConversationKey={activePlanningConversationKey}
            lines={terminalLines}
            busy={activePlanningSessionBusy}
            value={planningInput}
            selectedPresetKey={selectedPlanningPresetKey}
            presetOptions={planningPresetOptions}
            draftPlanAvailable={draftPlanAvailable}
            draftPlanSummary={draftPlanSummary}
            planningStream={activePlanningStream}
            readOnly={activePlanningReadOnly}
            mode={activePlanningMode}
            terminalSession={activePlanningTerminalSession}
            terminalBusy={activePlanningTerminalBusy}
            terminalError={activePlanningTerminalError}
            submittedPlanName={activePlanningSession.submittedPlanName}
            onValueChange={setPlanningInput}
            onSubmit={() => void handlePlanningSubmit()}
            onPresetChange={setSelectedPlanningPresetKey}
            onModeChange={(mode) => void handlePlanningModeChange(mode)}
            onExpand={() => setPlanningTerminalExpanded(true)}
            onOpenGraph={() => navigatePlanGraphAndFit('planning-open-graph')}
          />
        </div>
      </div>
      {renderPlanningContextPanel()}
    </div>
  );
  const renderBrowserRail = (): JSX.Element => (
    <div data-testid="browser-rail" className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card/45">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-4">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{browserSurfaceTitle}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{browserSurfaceSubtitle}</p>
        </div>
        <button
          type="button"
          aria-label="Close browser panel"
          data-testid="browser-rail-dismiss"
          onClick={handleDismissBrowserSurface}
          className="rounded-lg border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
        >
          Close
        </button>
      </div>
      <div className={RAIL_LIST_FRAME_CLASS}>
        {sidebarSurface === 'workflows'
          ? renderWorkflowsList()
          : renderTaskList(attentionEntries, 'All clear', 'Nothing needs a decision right now.')}
      </div>
    </div>
  );
  const renderGraphTerminalChrome = (): JSX.Element => (
    <div
      data-testid="graph-terminal-chrome"
      data-keyboard-region="bottomBar"
      tabIndex={0}
      data-keyboard-active={keyboardRegion === 'bottomBar' ? 'true' : 'false'}
      className={`outline-none ${keyboardRegion === 'bottomBar' ? 'ring-2 ring-inset ring-ring/50' : ''}`}
    >
      {sidebarSurface === 'planning' && (
        <WorkflowStatusChips
          workflows={workflows}
          activeFilters={statusFilters}
          keyboardActiveKey={keyboardRegion === 'bottomBar' ? visibleStatusKeys[bottomStatusIndex] ?? null : null}
          onStatusClick={handleStatusClick}
          queueStatus={queueStatus}
          onOpenRunningSurface={() => selectViewMode('queue')}
        />
      )}
      <TerminalDrawer
        state={terminalDrawerState}
        onCycle={() =>
          setTerminalDrawerState((prev) =>
            prev === 'minimized' ? 'partial' : prev === 'partial' ? 'maximized' : 'minimized',
          )
        }
        sessions={terminalSessions}
        activeSessionId={activeTerminalSessionId}
        onSelectSession={setActiveTerminalSessionId}
        onCloseSession={(sessionId) => void handleCloseTerminalSession(sessionId)}
        taskLabels={terminalTaskLabels}
      />
    </div>
  );


  const renderBrowserDetailWorkspace = (): JSX.Element => (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b border-border bg-card/50 px-4 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2
              className="text-lg font-semibold text-foreground line-clamp-2"
              title={browserSelectedTitle}
            >
              {browserSelectedTitle}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{browserSelectedContext}</p>
            <div className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${browserStatusToneClass}`}>
              {browserSelectedStatus}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {renderGraphActions(true)}
            <button
              type="button"
              aria-label="Return home"
              data-testid="browser-return-home"
              onClick={handleDismissBrowserSurface}
              className="rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
            >
              Home
            </button>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 flex flex-col overflow-hidden">
        {renderGraphCanvas()}
      </div>
      {viewMode === 'dag' && renderGraphTerminalChrome()}
    </div>
  );

  const homeSubtitle = workflows.size === 0
    ? 'No plan yet — draft one from Home.'
    : selectedWorkflow
      ? `${selectedWorkflow.name} · ${formatWorkflowStatus(selectedWorkflow.status)}`
      : `${workflowEntries.length} workflow${workflowEntries.length === 1 ? '' : 's'} ready`;
  return (
    <div ref={appRootRef} className="h-screen flex flex-col bg-background text-foreground font-sans" onClick={() => closeContextMenu()}>
      <Toaster
        theme="dark"
        position="bottom-right"
        richColors
        closeButton
        toastOptions={{
          className: 'font-sans',
          style: {
            background: 'rgb(23 23 23)',
            border: '1px solid var(--border-color)',
            color: 'rgb(250 250 250)',
            fontSize: '13px',
          },
        }}
      />
      <CommandPalette
        enabled={
          !contextMenu
          && !workflowContextMenu
          && !searchOpen
          && modal.type === 'none'
          && !graphMaximized
          && !planningTerminalExpanded
        }
        workflowEntries={commandPaletteWorkflowEntries}
        attentionEntries={commandPaletteAttentionEntries}
        runningEntries={commandPaletteRunningEntries}
        workflowCount={workflowEntries.length}
        attentionCount={attentionEntries.length}
        onSelectSurface={handleSelectSidebarSurface}
        onSelectWorkflow={selectWorkflowById}
        onSelectTask={selectTaskById}
        onOpenSettings={() => {
          cancelPendingSystemSetupAutoOpen();
          setShowSystemSetup(true);
        }}
        planningSessionCount={planningSessions.length}
      />

      {showSystemBanner && (
        <div className="px-4 py-3 border-b border-amber-700 bg-amber-950/50 flex items-center justify-between gap-4">
          <div className="text-sm text-amber-100">
            {missingRequiredTool
              ? `${missingRequiredTool.name} is missing. Invoker needs it for local workflows.`
              : needsBundledSkillsPrompt
                ? 'Invoker AI helpers are ready to install for Codex, Claude, Cursor, and OMP. Install them before using one-command plan handoff.'
              : installedAgentCount === 0
                ? 'No Claude or Codex CLI detected yet. Install one before running agent-backed execution tasks.'
                : 'Review local prerequisites before running packaged workflows.'}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              onClick={() => { cancelPendingSystemSetupAutoOpen(); setShowSystemSetup(true); }}
              className="bg-amber-600 text-white hover:bg-amber-500"
            >
              Open Setup
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { cancelPendingSystemSetupAutoOpen(); setShowSystemBanner(false); }}
              className="text-amber-200 hover:text-white"
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {runtimeStatus?.mode === 'connection-lost' ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="connection-lost-banner"
          className="border-b border-border-strong bg-secondary px-4 py-2 text-sm text-foreground"
        >
          <span className="font-semibold text-foreground">Connection lost.</span>{' '}
          This window lost contact with the write owner and cannot make changes until the connection is restored.
        </div>
      ) : runtimeStatus?.readOnly ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="read-only-mode-banner"
          className="border-b border-border-strong bg-secondary px-4 py-2 text-sm text-foreground"
        >
          <span className="font-semibold text-foreground">Read-only mode.</span>{' '}
          This window can browse workflows, but it cannot make changes until the write owner is available.
        </div>
      ) : null}
      {/* Main content */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <LeftStatusColumn
          workflowCount={workflowEntries.length}
          attentionCount={attentionEntries.length}
          workerStatus={workerStatus}
          planningSessionCount={planningSessions.length}
          planningAttentionCount={planningAttentionCount}
          selectedSurface={sidebarSurface}
          collapsed={sidebarCollapsed}
          onSelectSurface={handleSelectSidebarSurface}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
          onOpenSettings={() => {
            cancelPendingSystemSetupAutoOpen();
            setShowSystemSetup(true);
          }}
          theme={theme}
          onToggleTheme={toggleTheme}
        />

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
            {sidebarSurface === 'home' ? (
              renderPlanningTerminalSurface()
            ) : sidebarSurface === 'planning' ? (
              renderGraphWorkspace('Plan graph', homeSubtitle, true)
            ) : sidebarSurface === 'workers' ? (
              renderWorkersSurface()
            ) : (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                {renderBrowserRail()}
                {renderBrowserDetailWorkspace()}
              </div>
            )}

            {sidebarSurface === 'planning' && viewMode === 'dag' && renderGraphTerminalChrome()}
          </main>

          {sidebarSurface !== 'home' && sidebarSurface !== 'workers' && (
            <div
              data-testid="workflow-inspector-shell"
              data-keyboard-region="inspector"
              tabIndex={0}
              data-keyboard-active={keyboardRegion === 'inspector' ? 'true' : 'false'}
              className={`${showEmptyPlanGraphCta || showInspectorPlaceholder ? 'w-96' : effectiveInspectorCollapsed ? 'w-16' : 'w-96'} transition-all duration-150 outline-none ${keyboardRegion === 'inspector' ? 'ring-2 ring-inset ring-ring/50' : ''}`}
            >
              {showEmptyPlanGraphCta ? (
                <EmptyPlanGraphCta
                  creationError={planningSubmitError?.message}
                  draftPlan={draftPlanAvailable && draftPlanSummary ? draftPlanSummary : undefined}
                  onCreateWorkflow={draftPlanAvailable ? () => void handlePlanningSubmitDraft() : undefined}
                  onGoHome={() => navigatePlanningHome('empty-graph-cta')}
                />
              ) : showInspectorPlaceholder ? (
                <EmptyInspectorPlaceholder />
              ) : showWorkerDetailsPanel ? (
                <WorkerDetailsPanel
                  worker={selectedWorker}
                  tasks={tasks}
                  workflows={workflows}
                  collapsed={effectiveInspectorCollapsed}
                  onToggleCollapsed={handleToggleInspectorCollapsed}
                  onTaskClick={handleTaskClick}
                />
              ) : (
                <WorkflowInspector
                  workflow={displayedSelectedWorkflowGraph?.workflow ?? selectedWorkflow}
                  task={selectedTask}
                  workflowTasks={displayedSelectedWorkflowGraph?.tasks ?? miniDagTasks}
                  reviewGate={selectedWorkflow ? reviewGateByWorkflowId[selectedWorkflow.id] ?? null : null}
                  actionNode={viewMode === 'actionGraph' ? selectedActionNode : null}
                  mutationFailure={selectedTaskId ? mutationFailuresByTaskId.get(selectedTaskId) ?? null : null}
                  collapsed={effectiveInspectorCollapsed}
                  advancedExpanded={advancedMetadataExpanded}
                  remoteTargets={remoteTargets}
                  executionPools={executionPools}
                  executionHarnesses={executionHarnesses}
                  executionDefaults={executionDefaults}
                  onEditAgent={handleEditAgent}
                  onEditModel={handleEditModel}
                  onEditPrompt={handleEditPrompt}
                  onEditCommand={handleEditCommand}
                  onApprove={openApprovalModal}
                  onReject={openRejectModal}
                  onRestartTask={handleRestartTask}
                  onRecreateTask={handleRecreateTask}
                  onSetMergeBranch={handleSetMergeBranch}
                  onSetMergeMode={handleSetMergeMode}
                  onToggleCollapsed={handleToggleInspectorCollapsed}
                  onToggleAdvanced={() => setAdvancedMetadataExpanded((prev) => !prev)}
                />
              )}
            </div>
          )}
        </div>
      </div>


      {planningTerminalExpanded && (
        <div
          data-testid="invoker-terminal-expanded"
          role="dialog"
          aria-modal="true"
          aria-label="Planning chat"
          className="fixed inset-0 z-50 flex flex-col bg-card"
        >
          <InvokerTerminal
            activeConversationKey={activePlanningConversationKey}
            lines={terminalLines}
            busy={activePlanningSessionBusy}
            value={planningInput}
            selectedPresetKey={selectedPlanningPresetKey}
            presetOptions={planningPresetOptions}
            draftPlanAvailable={draftPlanAvailable}
            draftPlanSummary={draftPlanSummary}
            planningStream={activePlanningStream}
            expanded
            mode={activePlanningMode}
            terminalSession={activePlanningTerminalSession}
            terminalBusy={activePlanningTerminalBusy}
            terminalError={activePlanningTerminalError}
            submittedPlanName={activePlanningSession.submittedPlanName}
            onValueChange={setPlanningInput}
            readOnly={activePlanningReadOnly}
            onSubmit={() => void handlePlanningSubmit()}
            onPresetChange={setSelectedPlanningPresetKey}
            onModeChange={(mode) => void handlePlanningModeChange(mode)}
            onExpand={() => setPlanningTerminalExpanded(true)}
            onCloseExpanded={() => setPlanningTerminalExpanded(false)}
            onOpenGraph={() => {
              setPlanningTerminalExpanded(false);
              navigatePlanGraphAndFit('planning-expanded-open-graph');
            }}
          />
        </div>
      )}

      {graphMaximized && (
        <div
          data-testid="graph-maximized-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Full graph"
          className="fixed inset-0 z-50 flex flex-col bg-card"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Full graph</h2>
              <p className="text-xs text-muted-foreground">Press Escape to return.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setGraphMaximized(false)}
            >
              Close
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            {displayedSelectedWorkflowGraph !== null ? (
              <TaskDAG
                tasks={displayedSelectedWorkflowGraph.tasks}
                workflows={selectedTaskDagWorkflows}
                selectedTaskId={selectedTaskId}
                cameraCommand={cameraCommand}
                onTaskClick={handleTaskClick}
                onTaskDoubleClick={handleTaskDoubleClick}
                onTaskContextMenu={handleTaskContextMenu}
                statusFilters={new Set<string>()}
                runningTaskIds={runningTaskIds}
                surfaceMode="overlay"
              />
            ) : (
              <WorkflowGraph
                workflows={workflows}
                selectedWorkflowId={selectedWorkflow?.id ?? null}
                cameraCommand={cameraCommand}
                initialViewport={workflowGraphViewportRef.current}
                statusFilters={statusFilters}
                coreActivityByWorkflow={coreActivityByWorkflow}
                onSelectWorkflow={handleWorkflowClick}
                onWorkflowContextMenu={handleWorkflowContextMenu}
                onViewportSnapshot={handleWorkflowGraphViewportSnapshot}
              />
            )}
          </div>
        </div>
      )}

      {searchOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Search workflows and tasks"
          data-testid="keyboard-search-overlay"
          className="fixed inset-0 z-40 flex items-start justify-center bg-black/45 px-4 pt-[12vh]"
          onClick={() => setSearchOpen(false)}
        >
          <div
            className="w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-background shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              ref={searchInputRef}
              data-testid="keyboard-search-input"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search workflows, tasks, summaries, commands, or PRs"
              className="w-full border-b border-border bg-card px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <div
              role="listbox"
              data-testid="keyboard-search-results"
              className="max-h-[360px] overflow-auto py-1"
            >
              {searchQuery.trim() && searchResults.length === 0 && (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">No matches</div>
              )}
              {!searchQuery.trim() && (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground">Start typing to search workflows and tasks</div>
              )}
              {searchResults.map((result, index) => (
                <button
                  key={`${result.kind}:${result.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === searchActiveIndex}
                  data-testid={`keyboard-search-result-${result.kind}-${result.id}`}
                  className={`flex w-full flex-col px-4 py-2 text-left text-sm ${index === searchActiveIndex ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-secondary'}`}
                  onMouseEnter={() => setSearchActiveIndex(index)}
                  onClick={() => activateSearchResult(result)}
                >
                  <span className="truncate font-medium">{result.title}</span>
                  <span className="truncate text-xs text-muted-foreground">{result.subtitle}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {startReadyPreview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="start-ready-preview-title"
          data-testid="start-ready-preview-dialog"
          className="fixed inset-0 z-40 flex items-start justify-center bg-black/45 px-4 pt-[16vh]"
          onClick={() => setStartReadyPreview(null)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-border bg-background shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-border px-4 py-3">
              <h2 id="start-ready-preview-title" className="text-sm font-semibold text-foreground">
                {startReadyPreviewMode === 'failedPendingAndRunning'
                  ? 'Start and recreate failed, pending, and running'
                  : startReadyPreviewMode === 'failedAndPending'
                    ? 'Start and recreate failed and pending'
                    : 'Start and recreate failed'}
              </h2>
            </div>
            <div className="space-y-2 px-4 py-4 text-sm">
              {([
                ['Ready tasks', startReadyPreview.preview.readyTaskIds.length],
                ['Recoverable tasks', startReadyPreview.preview.recoverableTaskIds.length],
                ['Failed workflows', startReadyPreview.preview.failedWorkflowIds.length],
                ...(startReadyPreviewMode === 'failedAndPending'
                  || startReadyPreviewMode === 'failedPendingAndRunning'
                  ? [
                      ['Pending workflows', startReadyPreview.preview.pendingWorkflowIds.length] as [string, number],
                      ['Pending tasks', startReadyPreview.preview.skipped.pendingTasks] as [string, number],
                    ]
                  : []),
                ...(startReadyPreviewMode === 'failedPendingAndRunning'
                  ? [
                      ['Running workflows', startReadyPreview.preview.runningWorkflowIds.length] as [string, number],
                      ['Running tasks', startReadyPreview.preview.skipped.runningTasks] as [string, number],
                    ]
                  : []),
                ['Awaiting approval', startReadyPreview.preview.skipped.awaitingApproval],
                ['Review ready', startReadyPreview.preview.skipped.reviewReady],
                ['Blocked', startReadyPreview.preview.skipped.blocked],
              ] as Array<[string, number]>).map(([label, value]) => (
                <div key={label} className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-medium text-foreground">{value}</span>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
              <button
                type="button"
                className="rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
                onClick={() => setStartReadyPreview(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="start-ready-preview-confirm"
                disabled={startReadyBusy}
                className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void handleConfirmStartAndRecreateFailed()}
              >
                {startReadyBusy ? 'Starting…' : 'Start and recreate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      {modal.type === 'input' && (
        <InputModal
          task={modal.task}
          onSubmit={handleProvideInput}
          onClose={closeModal}
        />
      )}

      {modal.type === 'approval' && (
        <ApprovalModal
          task={modal.task}
          onApprove={handleApprove}
          onReject={handleReject}
          onClose={closeModal}
          initialAction={modal.action}
          onFinish={modal.task.config.workflowId ? workflows.get(modal.task.config.workflowId)?.onFinish : undefined}
        />
      )}

      {modal.type === 'experiment' && (
        <ExperimentModal
          task={modal.task}
          onSelect={handleSelectExperiment}
          onClose={closeModal}
        />
      )}

      {modal.type === 'replace' && (
        <ReplaceTaskModal
          task={modal.task}
          onSubmit={handleReplaceSubmit}
          onClose={closeModal}
        />
      )}

      {showSystemSetup && (
        <SystemSetupModal
          diagnostics={systemDiagnostics}
          installPending={installSkillsPending}
          installError={installSkillsError}
          onInstallBundledSkills={handleInstallBundledSkills}
          updateCliPending={updateCliPending}
          setupPending={setupPending}
          setupResult={setupResult}
          onRunSetup={handleRunInvokerCliSetup}
          updateCliError={updateCliError}
          onUpdateInvokerCli={handleUpdateInvokerCli}
          onClose={() => { cancelPendingSystemSetupAutoOpen(); setShowSystemSetup(false); }}
        />
      )}

      {workflowContextMenu && (
        <WorkflowContextMenu
          x={workflowContextMenu.x}
          y={workflowContextMenu.y}
          workflowId={workflowContextMenu.workflowId}
          onOpenWorkflow={handleWorkflowClick}
          onOpenPr={handleOpenWorkflowPr}
          onRetryWorkflow={(workflowId) => void handleRetryWorkflow(workflowId)}
          onRebaseRetry={(workflowId) => void handleRebaseRetry(workflowId)}
          onRebaseRecreate={(workflowId) => void handleRebaseRecreate(workflowId)}
          onRecreateWorkflow={(workflowId) => void handleRecreateWorkflow(workflowId)}
          onCancelWorkflow={(workflowId) => void handleCancelWorkflow(workflowId)}
          onDeleteWorkflow={(workflowId) => void handleDeleteWorkflow(workflowId)}
          onDetachWorkflow={(workflowId) => void handleDetachWorkflow(workflowId)}
          canDetach={(workflows.get(workflowContextMenu.workflowId)?.externalDependencies?.length ?? 0) === 1}
          onCopyWorkflowId={handleCopyWorkflowId}
          onClose={closeContextMenu}
          autoFocus={Boolean(workflowContextMenu.returnFocusRegion)}
        />
      )}

      {detachNotice && (
        <div
          role="status"
          aria-live="polite"
          data-testid="detach-feedback"
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border-strong bg-secondary px-4 py-2 text-sm text-foreground shadow-xl"
        >
          {detachNotice}
        </div>
      )}

      {contextMenu && contextMenuTask && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          task={contextMenuTask}
          onRestart={handleRestartTask}
          onReplace={handleReplaceTask}
          onOpenTerminal={handleOpenTerminal}
          onRecreateTask={handleRecreateTask}
          onRecreateDownstream={handleRecreateDownstream}
          onFix={handleFix}
          onCancel={handleCancelTask}
          onDelete={handleDeleteTask}
          onClose={closeContextMenu}
          autoFocus={Boolean(contextMenu.returnFocusRegion)}
        />
      )}
    </div>
  );
}
