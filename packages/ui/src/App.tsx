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
import type { ActionGraphNode, InAppPlanningSessionStatus, InAppPlanningSessionSummary, InvokerSetupRequest, InvokerSetupResult, ReviewGateQueryResponse, RuntimeStatus, TerminalSessionDescriptor } from '@invoker/contracts';
import type { TaskState, TaskReplacementDef, ExternalGatePolicyUpdate, WorkflowMeta, WorkflowStatus } from './types.js';
import type { SidebarSurface } from './lib/workflow-progress-surfaces.js';
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
import { groupWorkflowCoreActivity } from './lib/workflow-core-activity.js';
import { ActionGraphView } from './components/ActionGraphView.js';
import { WorkflowStatusChips } from './components/WorkflowStatusChips.js';
import { TerminalDrawer, type TerminalDrawerState } from './components/TerminalDrawer.js';
import { LeftStatusColumn } from './components/LeftStatusColumn.js';
import { InvokerTerminal, type InvokerTerminalLine } from './components/InvokerTerminal.js';
import {
  getAttentionTaskEntries,
  getRunningTaskEntries,
  getSortedWorkflows,
  formatTaskStatus,
  formatWorkflowStatus,
} from './lib/workflow-progress-surfaces.js';
import {
  isExperimentSpawnPivotTask,
  EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE,
} from './isExperimentSpawnPivot.js';
import {
  createGraphCameraCommandIssuer,
  loadCameraLockPreference,
  saveCameraLockPreference,
  type CameraLockPreference,
  type GraphCameraCommand,
  type GraphCameraCommandInput,
  type GraphCameraCommandIssuer,
  type GraphScope,
} from './lib/graph-camera.js';
import type { SystemDiagnostics } from '@invoker/contracts';

type ModalState =
  | { type: 'none' }
  | { type: 'input'; task: TaskState }
  | { type: 'approval'; task: TaskState; action: 'approve' | 'reject' }
  | { type: 'experiment'; task: TaskState }
  | { type: 'replace'; task: TaskState };

type KeyboardRegion = 'workflowGraph' | 'taskGraph' | 'inspector' | 'bottomBar';
type GraphKeyboardRegion = Extract<KeyboardRegion, 'workflowGraph' | 'taskGraph'>;
type ContextMenuCloseOptions = { restoreFocus?: boolean };
type ContextMenuState = { x: number; y: number; taskId: string; returnFocusRegion?: GraphKeyboardRegion };
type WorkflowContextMenuState = { x: number; y: number; workflowId: string; returnFocusRegion?: GraphKeyboardRegion };
type SearchResult =
  | { kind: 'workflow'; id: string; title: string; subtitle: string }
  | { kind: 'task'; id: string; workflowId: string | null; title: string; subtitle: string };

const KEYBOARD_REGION_ORDER: readonly KeyboardRegion[] = ['workflowGraph', 'taskGraph', 'inspector', 'bottomBar'];
const SIDEBAR_NAV_ITEM_SELECTOR = '[data-sidebar-nav-item]';
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
type PlanningSessionView = Omit<InAppPlanningSessionSummary, 'messages'> & {
  messages: InvokerTerminalLine[];
  input: string;
  busy: boolean;
  conversationKey: string;
};

function makeInitialPlanningSession(now: string = new Date().toISOString()): PlanningSessionView {
  return {
    id: 'local-planning-session-1',
    title: 'Untitled plan',
    status: 'still_discussing',
    presetKey: '',
    messages: [{ id: 1, text: 'Ask Invoker what you want to build.', role: 'system', tone: 'muted' }],
    input: '',
    draftPlanAvailable: false,
    busy: false,
    createdAt: now,
    updatedAt: now,
    conversationKey: 'local-planning-session-1',
  };
}

function planningStatusLabel(status: InAppPlanningSessionStatus): string {
  switch (status) {
    case 'waiting_for_answer':
      return 'Waiting for you';
    case 'draft_ready':
      return 'Draft ready';
    case 'submitted':
      return 'Submitted';
    case 'still_discussing':
      return 'Still discussing';
  }
}

function planningStatusClass(status: InAppPlanningSessionStatus): string {
  switch (status) {
    case 'waiting_for_answer':
      return 'bg-amber-950/70 text-amber-100';
    case 'draft_ready':
      return 'bg-emerald-950/70 text-emerald-100';
    case 'submitted':
      return 'bg-gray-800 text-gray-200';
    case 'still_discussing':
      return 'bg-blue-950/70 text-blue-100';
  }
}

function previewPlanningMessage(session: PlanningSessionView): string {
  const last = [...session.messages].reverse().find((line) => line.role !== 'system') ?? session.messages.at(-1);
  return last?.text.replace(/\s+/g, ' ').trim() || 'No messages yet';
}

function relativePlanningUpdatedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Updated just now';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'Updated just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `Updated ${days}d ago`;
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
  }, []);

  const runAction = (action: (workflowId: string) => void) => {
    action(workflowId);
    onClose({ restoreFocus: autoFocus });
  };

  const buttonClass = 'w-full px-3 py-1.5 text-left text-sm text-gray-100 hover:bg-gray-700';
  const dangerButtonClass = 'w-full px-3 py-1.5 text-left text-sm text-red-300 hover:bg-gray-700';
  const visibleItems: WorkflowMenuItem[] = [
    { id: 'open-workflow', label: 'Open Workflow', className: buttonClass, action: () => runAction(onOpenWorkflow) },
    { id: 'open-pr', label: 'Open PR', className: buttonClass, action: () => runAction(onOpenPr) },
    { id: 'retry-workflow', label: 'Retry Workflow', className: buttonClass, action: () => runAction(onRetryWorkflow) },
    { id: 'copy-workflow-id', label: 'Copy Workflow ID', className: buttonClass, action: () => runAction(onCopyWorkflowId) },
    ...(!showMore
      ? [{
          id: 'more',
          label: 'More',
          className: 'w-full px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-gray-700',
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
      className="fixed z-50 min-w-[200px] rounded-lg border border-gray-600 bg-gray-800 py-1 shadow-xl"
      style={{ left: position.left, top: position.top }}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onClick={(event) => event.stopPropagation()}
    >
      {visibleItems.map((item, index) => (
        <div key={item.id}>
          {item.separator && <div className="my-1 border-t border-gray-600" />}
          <button
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            type="button"
            role="menuitem"
            onClick={item.action}
            onMouseEnter={() => setFocusedIndex(index)}
            className={`${item.className} ${index === focusedIndex ? 'bg-gray-700' : ''}`}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}

function EmptyGraphTutorial(): JSX.Element {
  return (
    <aside className="h-full w-full border-l border-gray-800 bg-gray-900/90 p-4">
      <div className="rounded-xl border border-gray-800 bg-gray-950/70 p-4">
        <h2 className="text-sm font-semibold text-gray-100">What to expect</h2>
        <ol className="mt-3 space-y-3 text-sm text-gray-400">
          <li>
            <div className="font-medium text-gray-200">1. Type a goal</div>
            <div className="mt-1 text-xs text-gray-500">Describe the change in the terminal to generate a plan.</div>
          </li>
          <li>
            <div className="font-medium text-gray-200">2. Review the plan</div>
            <div className="mt-1 text-xs text-gray-500">Check the graph before starting work.</div>
          </li>
          <li>
            <div className="font-medium text-gray-200">3. Run it</div>
            <div className="mt-1 text-xs text-gray-500">Start the workflow when the plan looks right.</div>
          </li>
        </ol>
      </div>
    </aside>
  );
}

function EmptyInspectorPlaceholder(): JSX.Element {
  return (
    <aside className="h-full w-full border-l border-gray-800 bg-gray-900/90 p-4">
      <div className="rounded-xl border border-dashed border-gray-800 bg-gray-950/50 p-4">
        <h2 className="text-sm font-semibold text-gray-100">No task selected</h2>
        <p className="mt-2 text-sm text-gray-400">Select a task in the graph to see details.</p>
        <p className="mt-2 text-xs text-gray-500">Status, logs, and actions will appear here.</p>
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
    await refreshWorkerStatus();
  }, [invoker, refreshWorkerStatus]);
  const handleStopWorker = useCallback(async (kind: string) => {
    await invoker.stopWorker(kind);
    await refreshWorkerStatus();
  }, [invoker, refreshWorkerStatus]);
  const runningTaskIds = useMemo(
    () => new Set((queueStatus?.running ?? []).map((entry) => entry.taskId)),
    [queueStatus],
  );
  const graphSurfaceRef = useRef<HTMLDivElement>(null);
  const graphActionsMenuRef = useRef<HTMLDivElement>(null);
  const lastGoodSelectedWorkflowGraphRef = useRef<SelectedWorkflowGraphSnapshot | null>(null);
  const [sidebarSurface, setSidebarSurface] = useState<SidebarSurface>('home');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedWorkerKind, setSelectedWorkerKind] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [reviewGateByWorkflowId, setReviewGateByWorkflowId] = useState<Record<string, ReviewGateQueryResponse | null>>({});
  const [stickySelectedWorkflow, setStickySelectedWorkflow] = useState<WorkflowMeta | null>(null);
  const [workflowSelectionDismissed, setWorkflowSelectionDismissed] = useState(false);
  const [modal, setModal] = useState<ModalState>({ type: 'none' });
  const [hasLoadedPlan, setHasLoadedPlan] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [planName, setPlanName] = useState<string | null>(null);
  const [planningSessions, setPlanningSessions] = useState<PlanningSessionView[]>(() => [makeInitialPlanningSession()]);
  const [activePlanningSessionId, setActivePlanningSessionId] = useState('local-planning-session-1');
  const nextPlanningSessionLocalIdRef = useRef(2);
  const nextTerminalLineIdRef = useRef(2);
  const [planningPresetOptions, setPlanningPresetOptions] = useState<Array<{ key: string; label: string; isDefault?: boolean }>>([]);
  const [selectedPlanningPresetKey, setSelectedPlanningPresetKey] = useState('');
  const [planningSubmitError, setPlanningSubmitError] = useState<{ title: string; message: string } | null>(null);
  const [planningTerminalExpanded, setPlanningTerminalExpanded] = useState(false);
  const activePlanningSession = useMemo(
    () => planningSessions.find((session) => session.id === activePlanningSessionId) ?? planningSessions[0] ?? makeInitialPlanningSession(),
    [activePlanningSessionId, planningSessions],
  );
  const activePlanningConversationKey = activePlanningSession.conversationKey;
  const terminalLines = activePlanningSession.messages;
  const planningInput = activePlanningSession.input;
  const planningSessionId = activePlanningSession.id.startsWith('local-') ? null : activePlanningSession.id;
  const draftPlanAvailable = activePlanningSession.draftPlanAvailable;
  const draftPlanSummary = activePlanningSession.draftPlanSummary;
  const activePlanningSessionBusy = activePlanningSession.busy;
  const activePlanningSessionSubmitted = activePlanningSession.status === 'submitted';
  const [graphMaximized, setGraphMaximized] = useState(false);
  const [selectedActionNodeId, setSelectedActionNodeId] = useState<string | null>(null);
  const selectedActionNode = useMemo(
    () => actionGraph?.nodes.find((node) => node.id === selectedActionNodeId) ?? null,
    [actionGraph, selectedActionNodeId],
  );
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [remoteTargets, setRemoteTargets] = useState<string[]>([]);
  const [executionPools, setExecutionPools] = useState<string[]>([]);
  const [executionAgents, setExecutionAgents] = useState<string[]>([]);
  const [statusFilters, setStatusFilters] = useState<Set<WorkflowStatus>>(new Set());
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(
    () => (typeof window !== 'undefined' ? window.__INVOKER_BOOTSTRAP__?.runtimeStatus ?? null : null),
  );
  const [systemDiagnostics, setSystemDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [showSystemSetup, setShowSystemSetup] = useState(false);
  const [showSystemBanner, setShowSystemBanner] = useState(false);
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
  // Transient, user-visible outcome line for a confirmed workflow detach.
  const [detachNotice, setDetachNotice] = useState<string | null>(null);
  const [keyboardRegion, setKeyboardRegion] = useState<KeyboardRegion>('workflowGraph');
  const [previousGraphRegion, setPreviousGraphRegion] = useState<KeyboardRegion>('workflowGraph');
  // Typed graph camera state. The graph viewport is user-owned after the
  // initial render: only explicit navigation commands (issued through the
  // central factory) move it. No per-handler event++/requestId++ counters.
  const cameraIssuerRef = useRef<GraphCameraCommandIssuer | null>(null);
  if (!cameraIssuerRef.current) {
    cameraIssuerRef.current = createGraphCameraCommandIssuer();
  }
  const [cameraCommand, setCameraCommand] = useState<GraphCameraCommand | null>(null);
  const [cameraPreference, setCameraPreference] = useState<CameraLockPreference>(() =>
    loadCameraLockPreference(),
  );
  // Mirror preference into a ref so event handlers read the live value without
  // being re-created on every preference change.
  const cameraPreferenceRef = useRef(cameraPreference);
  useEffect(() => {
    cameraPreferenceRef.current = cameraPreference;
  }, [cameraPreference]);
  // Temporary, non-persisted suppression of the camera lock after a manual pan
  // or wheel zoom. The next explicit node selection clears it.
  const cameraSuppressedRef = useRef(false);
  const [bottomStatusIndex, setBottomStatusIndex] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const uiPerfThrottleRef = useRef<Record<string, number>>({});
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
    window.invoker?.getRemoteTargets?.().then(setRemoteTargets).catch(() => {});
    window.invoker?.getExecutionPools?.().then(setExecutionPools).catch(() => {});
    window.invoker?.getExecutionAgents?.().then(setExecutionAgents).catch(() => {});
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
    window.invoker?.terminalList?.().then((list) => {
      if (Array.isArray(list) && list.length > 0) {
        setTerminalSessions(list);
      }
    }).catch(() => {});
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

  const selectedTask = selectedTaskId ? tasks.get(selectedTaskId) ?? null : null;
  const selectedWorker = workerStatus?.workers.find((worker) => worker.kind === selectedWorkerKind) ?? null;
  const contextMenuTask = contextMenu ? tasks.get(contextMenu.taskId) ?? null : null;
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
    const firstWorkflowId = workflows.keys().next().value as string | undefined;
    setSelectedWorkflowId(firstWorkflowId ?? null);
  }, [selectedTask, selectedWorkflowId, selectedWorkflowTaskCount, workflowSelectionDismissed, workflows]);

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
  const attentionEntries = useMemo(() => getAttentionTaskEntries(tasks, workflows), [tasks, workflows]);
  const runningEntries = useMemo(() => getRunningTaskEntries(tasks, workflows, queueStatus), [tasks, workflows, queueStatus]);

  const searchResults = useMemo<SearchResult[]>(() => {
    const query = normalizedSearchText(searchQuery.trim());
    if (!query) return [];
    const results: SearchResult[] = [];
    for (const workflow of workflows.values()) {
      const workflowTasks = [...tasks.values()].filter((task) => task.config.workflowId === workflow.id);
      const reviewUrl = workflowTasks.find((task) => task.execution.reviewUrl)?.execution.reviewUrl;
      const haystack = [
        workflow.id,
        workflow.name,
        workflow.status,
        workflow.repoUrl,
        workflow.intermediateRepoUrl,
        reviewUrl,
      ].map(normalizedSearchText).join(' ');
      if (haystack.includes(query)) {
        results.push({
          kind: 'workflow',
          id: workflow.id,
          title: workflow.name || workflow.id,
          subtitle: `Workflow · ${workflow.status}`,
        });
      }
    }
    for (const task of tasks.values()) {
      const workflow = task.config.workflowId ? workflows.get(task.config.workflowId) : null;
      const haystack = [
        task.id,
        task.description,
        task.status,
        task.config.summary,
        task.config.prompt,
        task.config.command,
        task.execution.reviewUrl,
        workflow?.name,
      ].map(normalizedSearchText).join(' ');
      if (haystack.includes(query)) {
        results.push({
          kind: 'task',
          id: task.id,
          workflowId: task.config.workflowId ?? null,
          title: task.description || task.id,
          subtitle: `Task · ${workflow?.name ?? task.config.workflowId ?? 'unknown workflow'}`,
        });
      }
    }
    return results.slice(0, 12);
  }, [searchQuery, tasks, workflows]);

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

  // An explicit node selection (mouse click or arrow key) clears any temporary
  // manual suppression and re-centers the targeted graph when the lock is on.
  const recenterForSelection = useCallback((scope: GraphScope, target: string) => {
    cameraSuppressedRef.current = false;
    if (cameraPreferenceRef.current.enabled) {
      issueCameraCommand({ kind: 'centerSelection', scope, target, reason: 'selection' });
    }
  }, [issueCameraCommand]);

  // A manual pan or wheel zoom temporarily suppresses the lock and must not
  // autofocus the graph — no camera command is issued here.
  const handleManualViewport = useCallback(() => {
    cameraSuppressedRef.current = true;
  }, []);

  const selectWorkflowById = useCallback((workflowId: string) => {
    setWorkflowSelectionDismissed(false);
    setSelectedWorkflowId(workflowId);
    setSelectedTaskId(null);
    setContextMenu(null);
    setWorkflowContextMenu(null);
    recenterForSelection('workflow', workflowId);
    focusKeyboardRegion('workflowGraph');
  }, [focusKeyboardRegion, recenterForSelection]);

  const selectTaskById = useCallback((taskId: string) => {
    const task = tasks.get(taskId);
    if (!task) return;
    setSelectedTaskId(task.id);
    setWorkflowSelectionDismissed(false);
    if (task.config.workflowId) {
      setSelectedWorkflowId(task.config.workflowId);
    }
    setContextMenu(null);
    setWorkflowContextMenu(null);
    recenterForSelection('task', task.id);
    focusKeyboardRegion('taskGraph');
  }, [focusKeyboardRegion, recenterForSelection, tasks]);

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

      // F1 is the keyboard-only camera lock control. It is already ignored for
      // input/modal/terminal/editable targets by the guard above.
      if (event.key === 'F1') {
        event.preventDefault();
        const inTaskGraph = keyboardRegion === 'taskGraph';
        const scope: GraphScope = inTaskGraph ? 'task' : 'workflow';
        const target = inTaskGraph ? selectedTaskId : (selectedWorkflow?.id ?? selectedWorkflowId);
        const preference = cameraPreferenceRef.current;
        cameraSuppressedRef.current = false;
        if (preference.mode === 'toggle') {
          // Toggle mode flips the lock; enabling it immediately centers the
          // current selection.
          const nextEnabled = !preference.enabled;
          const nextPreference: CameraLockPreference = { mode: preference.mode, enabled: nextEnabled };
          setCameraPreference(nextPreference);
          saveCameraLockPreference(nextPreference);
          if (nextEnabled && target) {
            issueCameraCommand({ kind: 'centerSelection', scope, target, reason: 'f1-toggle-enable' });
          }
        } else if (target) {
          // Once mode centers a single time without changing the preference.
          issueCameraCommand({ kind: 'centerSelection', scope, target, reason: 'f1-once' });
        }
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        const currentIndex = KEYBOARD_REGION_ORDER.indexOf(keyboardRegion);
        const nextIndex = event.shiftKey
          ? (currentIndex - 1 + KEYBOARD_REGION_ORDER.length) % KEYBOARD_REGION_ORDER.length
          : (currentIndex + 1) % KEYBOARD_REGION_ORDER.length;
        focusKeyboardRegion(KEYBOARD_REGION_ORDER[nextIndex]);
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
    setSelectedTaskId(task.id);
    setWorkflowSelectionDismissed(false);
    if (task.config.workflowId) {
      setSelectedWorkflowId(task.config.workflowId);
    }
    setWorkflowContextMenu(null);
    recenterForSelection('task', task.id);
  }, [recenterForSelection]);

  const openTerminalForTaskId = useCallback(async (taskId: string) => {
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
    setWorkflowSelectionDismissed(false);
    setSelectedWorkflowId(workflowId);
    setSelectedTaskId(null);
    setContextMenu(null);
    setWorkflowContextMenu(null);
    recenterForSelection('workflow', workflowId);
  }, [recenterForSelection]);

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

    if (sidebarSurface === 'running') {
      if (!runningEntries.length) {
        if (selectedTaskId !== null || selectedWorkflowId !== null) {
          setSelectedTaskId(null);
          setSelectedWorkflowId(null);
          setWorkflowSelectionDismissed(false);
        }
        return;
      }
      if (runningEntries.some((entry) => entry.task.id === selectedTaskId)) {
        return;
      }
      selectTaskById(runningEntries[0].task.id);
    }
  }, [
    attentionEntries,
    runningEntries,
    selectTaskById,
    selectWorkflowById,
    selectedTaskId,
    selectedWorkflow?.id,
    selectedWorkflowId,
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
    if (viewMode !== 'dag' || sidebarSurface === 'home' || displayedSelectedWorkflowGraph === null) {
      return;
    }

    let cancelled = false;
    const fitFrame = requestAnimationFrame(() => {
      if (cancelled) return;
      issueCameraCommand({ kind: 'fitInitial', scope: 'task', reason: 'browser-surface' });

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
    displayedSelectedWorkflowGraph,
    issueCameraCommand,
    selectedTaskId,
    sidebarSurface,
    viewMode,
  ]);


  const handleDagSurfaceClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (contextMenu || workflowContextMenu) {
      setContextMenu(null);
      setWorkflowContextMenu(null);
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
      console.error('Failed to restart task:', err);
    }
  }, [invoker, trackAcceptedMutation]);

  const handleOpenTerminal = useCallback(
    (taskId: string) => {
      setContextMenu(null);
      void openTerminalForTaskId(taskId);
    },
    [openTerminalForTaskId],
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
      console.error('Failed to replace task:', err);
    }
  }, [trackAcceptedMutation]);

  const handleRebaseRetry = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.rebaseRetry(workflowId);
      trackAcceptedMutation(result);
    } catch (err) {
      console.error('Rebase and Retry failed:', err);
    }
  }, [trackAcceptedMutation]);

  const handleRebaseRecreate = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.rebaseRecreate(workflowId);
      trackAcceptedMutation(result);
    } catch (err) {
      console.error('Rebase and Recreate failed:', err);
    }
  }, [trackAcceptedMutation]);

  const handleRetryWorkflow = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.retryWorkflow(workflowId);
      trackAcceptedMutation(result);
    } catch (err) {
      console.error('Retry Workflow failed:', err);
    }
  }, [trackAcceptedMutation]);

  const handleRecreateWorkflow = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.recreateWorkflow(workflowId);
      trackAcceptedMutation(result);
    } catch (err) {
      console.error('Recreate Workflow failed:', err);
    }
  }, [trackAcceptedMutation]);

  const handleRecreateTask = useCallback(async (taskId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.recreateTask(taskId);
      trackAcceptedMutation(result);
    } catch (err) {
      console.error('Recreate from Task failed:', err);
    }
  }, [trackAcceptedMutation]);

  const handleRecreateDownstream = useCallback(async (taskId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.recreateDownstream(taskId);
      trackAcceptedMutation(result);
    } catch (err) {
      console.error('Recreate Downstream failed:', err);
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
      console.error('Delete Task failed:', err);
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
      console.error('Delete Workflow failed:', err);
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
      console.error('Detach Workflow failed:', err);
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
      console.error('Fix failed:', err);
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
      console.error('Failed to cancel task:', err);
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
      console.error('Failed to cancel workflow:', err);
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
    issueCameraCommand({ kind: 'fitInitial', scope: 'workflow', reason: 'manual-refresh' });
  }, [invoker, issueCameraCommand, refreshTaskGraph]);
  const updatePlanningSessionById = useCallback((sessionId: string, updater: (session: PlanningSessionView) => PlanningSessionView) => {
    setPlanningSessions((prev) => prev.map((session) => (
      session.id === sessionId ? updater(session) : session
    )));
  }, []);

  const updateActivePlanningSession = useCallback((updater: (session: PlanningSessionView) => PlanningSessionView) => {
    updatePlanningSessionById(activePlanningSessionId, updater);
  }, [activePlanningSessionId, updatePlanningSessionById]);

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

  const handleStart = useCallback(async (): Promise<boolean> => {
    if (!invoker) return false;
    try {
      await invoker.start();
      setHasStarted(true);
      return true;
    } catch (err) {
      console.error('Failed to start:', err);
      return false;
    }
  }, [invoker]);

  const handlePlanningSubmitDraft = useCallback(async () => {
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
        setHasStarted(false);
        setSidebarSurface('home');
        setWorkflowSelectionDismissed(false);
        setViewMode('dag');
        setGraphActionsMenuOpen(false);
        setPlanName(result.planName);
        setSelectedWorkflowId(result.workflowId);
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
        appendTerminalLine(
          result.workflowCount && result.workflowCount > 1
            ? `Plan "${result.planName}" submitted as ${result.workflowCount} stacked workflows. Review them, then Run.`
            : `Plan "${result.planName}" submitted to Invoker. Review it, then Run.`,
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
  }, [appendTerminalLine, invoker, planningSessionId, refreshTaskGraph, updatePlanningSessionById]);

  const handlePlanningSubmit = useCallback(async () => {
    const input = planningInput.trim();
    if (!input || activePlanningSessionBusy || activePlanningSessionSubmitted) return;
    appendTerminalLine(input, 'user');
    setPlanningInput('');
    setPlanningSubmitError(null);

    if (input.toLowerCase() === 'run') {
      if (!hasLoadedPlan || hasStarted) {
        appendTerminalLine(
          hasStarted ? 'Run already started.' : 'Create or submit a plan before running.',
          'system',
          'error',
        );
        return;
      }
      updatePlanningSessionById(activePlanningSessionId, (session) => ({ ...session, busy: true }));
      try {
        const started = await handleStart();
        appendTerminalLine(started ? 'Run started.' : 'Run failed to start.', 'system', started ? 'success' : 'error');
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
            messages: [...session.messages, { id: replyLineId, text: result.reply, role: 'assistant' }],
            draftPlanAvailable: result.draftPlanAvailable,
            draftPlanSummary: result.draftPlanAvailable ? result.draftPlanSummary : undefined,
            updatedAt,
          };
        }));
        setActivePlanningSessionId((currentSessionId) => (
          currentSessionId === previousSessionId ? result.sessionId : currentSessionId
        ));
        setHasLoadedPlan(false);
      } else {
        updatePlanningSessionById(previousSessionId, (session) => ({ ...session, busy: false }));
        appendTerminalLine(result.error, 'system', 'error');
        setPlanningSubmitError({ title: 'Planner could not respond', message: result.error });
      }
    } catch (err) {
      updatePlanningSessionById(previousSessionId, (session) => ({ ...session, busy: false }));
      const message = err instanceof Error ? err.message : 'Failed to reach the planner.';
      setPlanningSubmitError({ title: 'Planner could not respond', message });
      appendTerminalLine(message, 'system', 'error');
    }
  }, [
    activePlanningSessionBusy,
    activePlanningSessionId,
    activePlanningSessionSubmitted,
    appendTerminalLine,
    handlePlanningSubmitDraft,
    handleStart,
    hasLoadedPlan,
    hasStarted,
    invoker,
    planningInput,
    planningSessionId,
    selectedPlanningPresetKey,
    setPlanningInput,
    updatePlanningSessionById,
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
    nextTerminalLineIdRef.current += 1;
    setPlanningSessions((prev) => [session, ...prev]);
    setActivePlanningSessionId(session.id);
    setSidebarSurface('planning');
  }, [selectedPlanningPresetKey]);


  const handleStop = useCallback(async () => {
    if (!invoker) return;
    try {
      await invoker.stop();
    } catch (err) {
      console.error('Failed to stop:', err);
    }
  }, [invoker]);

  const handleClear = useCallback(async () => {
    if (!invoker) return;
    try {
      await invoker.clear();
      clearTasks();
      setHasLoadedPlan(false);
      setHasStarted(false);
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
      console.error('Failed to clear:', err);
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
      setHasStarted(false);
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
      console.error('Failed to delete workflows:', err);
    }
  }, [clearTasks, invoker]);
  const allSettled = useMemo(() => {
    if (tasks.size === 0) return false;
    for (const task of tasks.values()) {
      if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'closed' && task.status !== 'blocked') {
        return false;
      }
    }
    return true;
  }, [tasks]);

  const showStart = hasLoadedPlan && !hasStarted;
  const showStop = hasStarted && !allSettled;
  const showEmptyGraphTutorial = sidebarSurface === 'home' && !hasLoadedPlan && tasks.size === 0 && workflows.size === 0;
  const autoCollapseInspector = sidebarSurface !== 'home' && viewportWidth < 1440;
  const effectiveInspectorCollapsed = inspectorCollapsed || (autoCollapseInspector && !inspectorManualOpen);
  const showWorkerDetailsPanel = viewMode === 'queue' && sidebarSurface === 'workers';
  const showInspectorPlaceholder = !showEmptyGraphTutorial && !showWorkerDetailsPanel && !selectedTask && !selectedWorkflow && !(viewMode === 'actionGraph' && selectedActionNode);

  useEffect(() => {
    if (sidebarSurface === 'home' || !autoCollapseInspector) {
      setInspectorManualOpen(false);
    }
  }, [autoCollapseInspector, sidebarSurface]);
  useEffect(() => {
    if (!graphActionsMenuOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (graphActionsMenuRef.current?.contains(event.target as Node)) return;
      setGraphActionsMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setGraphActionsMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [graphActionsMenuOpen]);

  const selectViewMode = useCallback((nextView: 'dag' | 'history' | 'timeline' | 'queue' | 'actionGraph') => {
    setGraphActionsMenuOpen(false);
    if (nextView !== 'actionGraph' && selectedActionNodeId !== null) {
      setSelectedActionNodeId(null);
    }
    if (nextView === 'actionGraph') {
      setSidebarSurface('home');
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
      setSidebarSurface('home');
    }
    setViewMode(nextView);
  }, [selectedActionNodeId]);

  const handleToggleInspectorCollapsed = useCallback(() => {
    if (autoCollapseInspector) {
      setInspectorCollapsed(false);
      setInspectorManualOpen((prev) => !prev);
      return;
    }
    setInspectorManualOpen(false);
    setInspectorCollapsed((prev) => !prev);
  }, [autoCollapseInspector]);

  const handleSelectSidebarSurface = useCallback((nextSurface: SidebarSurface) => {
    setGraphActionsMenuOpen(false);
    if (nextSurface === 'workers') {
      setSidebarSurface('workers');
      setSidebarCollapsed(true);
      setInspectorCollapsed(true);
      setInspectorManualOpen(false);
      setStatusFilters(new Set<WorkflowStatus>());
      setViewMode('queue');
      return;
    }
    setViewMode('dag');
    if (nextSurface === 'home') {
      setSidebarSurface('home');
      setSidebarCollapsed(false);
      setInspectorManualOpen(false);
      return;
    }
    setSidebarSurface(nextSurface);
    setSidebarCollapsed(true);
    setInspectorManualOpen(false);
    setStatusFilters(new Set<WorkflowStatus>());
  }, []);

  const handleDismissBrowserSurface = useCallback(() => {
    setGraphActionsMenuOpen(false);
    setSidebarSurface('home');
    setSidebarCollapsed(false);
    setInspectorManualOpen(false);
    setViewMode('dag');
  }, []);

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
        console.error('Failed to edit task command:', err);
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
        console.error('Failed to edit task prompt:', err);
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
        console.error('Failed to edit task type:', err);
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
        console.error('Failed to edit task pool:', err);
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
        console.error('Failed to edit task agent:', err);
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
        console.error('Failed to set external gate policies:', err);
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
        console.error('Failed to set merge branch:', err);
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
        console.error('Failed to set merge mode:', err);
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
      {showStart && (
        <button
          type="button"
          data-testid="rail-start"
          onClick={handleStart}
          className="rounded bg-green-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600"
        >
          Run
        </button>
      )}
      {showStop && (
        <button
          type="button"
          data-testid="rail-stop"
          onClick={handleStop}
          className="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600"
        >
          Stop
        </button>
      )}
      <button
        type="button"
        data-testid="rail-refresh"
        onClick={handleRefresh}
        className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
      >
        Refresh
      </button>
      <button
        type="button"
        onClick={() => setGraphMaximized(true)}
        className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
      >
        Full graph ⤢
      </button>
      {showMoreMenu && (
        <div ref={graphActionsMenuRef} className="relative">
          <button
            type="button"
            data-testid="graph-more-button"
            onClick={() => setGraphActionsMenuOpen((open) => !open)}
            className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
          >
            More ▾
          </button>
          {graphActionsMenuOpen && (
            <div
              data-testid="graph-more-menu"
              className="absolute right-0 top-10 z-20 w-48 rounded-lg border border-gray-700 bg-gray-950 p-1 shadow-xl"
            >
              <button
                type="button"
                data-testid="rail-home"
                onClick={() => {
                  handleSelectSidebarSurface('home');
                  selectViewMode('dag');
                }}
                className="block w-full rounded px-3 py-2 text-left text-xs text-gray-200 hover:bg-gray-800"
              >
                Home
              </button>
              <button
                type="button"
                data-testid="rail-timeline"
                onClick={() => selectViewMode('timeline')}
                className="block w-full rounded px-3 py-2 text-left text-xs text-gray-200 hover:bg-gray-800"
              >
                Timeline
              </button>
              <button
                type="button"
                data-testid="rail-history"
                onClick={() => selectViewMode('history')}
                className="block w-full rounded px-3 py-2 text-left text-xs text-gray-200 hover:bg-gray-800"
              >
                History
              </button>
              <button
                type="button"
                data-testid="rail-action-graph"
                onClick={() => selectViewMode('actionGraph')}
                className="block w-full rounded px-3 py-2 text-left text-xs text-gray-200 hover:bg-gray-800"
              >
                Action Graph
              </button>
              <button
                type="button"
                data-testid="rail-queue"
                onClick={() => selectViewMode('queue')}
                className="block w-full rounded px-3 py-2 text-left text-xs text-gray-200 hover:bg-gray-800"
              >
                Queue
              </button>
              <div className="my-1 border-t border-gray-800" />
              <button
                type="button"
                data-testid="rail-clear"
                onClick={async () => {
                  setGraphActionsMenuOpen(false);
                  await handleClear();
                }}
                className="block w-full rounded px-3 py-2 text-left text-xs text-gray-200 hover:bg-gray-800"
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
        className={`flex h-full min-h-0 flex-1 outline-none ${keyboardRegion === 'taskGraph' ? 'ring-2 ring-inset ring-blue-300/60' : ''}`}
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
          onManualViewport={handleManualViewport}
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
          contentClassName="h-[250px]"
        >
          {graphBody}
        </FloatingGraphPanel>
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col p-4">
        <div
          data-testid="selected-workflow-mini-dag"
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-gray-700 bg-gray-900/95 shadow-lg"
        >
          <div className="border-b border-gray-700 px-3 py-2 text-[11px] text-gray-300">
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
      className={`flex-1 relative overflow-hidden border-r border-gray-800 bg-gray-900 outline-none ${keyboardRegion === 'workflowGraph' ? 'ring-2 ring-inset ring-blue-400/50' : ''}`}
      onClick={viewMode === 'dag' ? handleDagSurfaceClick : undefined}
    >
      {viewMode === 'queue' ? (
        <QueueView
          tasks={tasks}
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
        <TimelineView tasks={tasks} onTaskClick={handleTaskClick} selectedTaskId={selectedTaskId} />
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
          {sidebarSurface === 'home' && (
            <WorkflowGraph
              workflows={workflows}
              selectedWorkflowId={selectedWorkflow?.id ?? null}
              cameraCommand={cameraCommand}
              statusFilters={statusFilters}
              coreActivityByWorkflow={coreActivityByWorkflow}
              onSelectWorkflow={handleWorkflowClick}
              onWorkflowContextMenu={handleWorkflowContextMenu}
              onManualViewport={handleManualViewport}
            />
          )}
          {renderSelectedWorkflowTaskGraph(sidebarSurface === 'home')}
        </>
      )}
    </div>
  );

  const renderGraphWorkspace = (title: string, subtitle: string, showMoreMenu: boolean): JSX.Element => (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-gray-800 bg-gray-950/50 px-4 py-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-100">{title}</h2>
          <p className="text-xs text-gray-500">{subtitle}</p>
        </div>
        {renderGraphActions(showMoreMenu)}
      </div>
      {renderGraphCanvas()}
    </div>
  );

  const renderBrowserEmptyState = (title: string, copy: string): JSX.Element => (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div>
        <div className="text-sm font-medium text-gray-200">{title}</div>
        <div className="mt-2 text-sm text-gray-500">{copy}</div>
      </div>
    </div>
  );

  const workflowsSubtitle = `${workflowEntries.length} workflow${workflowEntries.length === 1 ? '' : 's'}`;
  const attentionSubtitle = attentionEntries.length === 0
    ? 'Nothing needs a decision right now.'
    : `${attentionEntries.length} item${attentionEntries.length === 1 ? '' : 's'} need attention.`;
  const runningSubtitle = runningEntries.length === 0
    ? 'No active tasks right now.'
    : `${runningEntries.length} task${runningEntries.length === 1 ? '' : 's'} active now.`;

  const browserSurfaceTitle = sidebarSurface === 'workflows'
    ? 'Workflows'
    : sidebarSurface === 'attention'
      ? 'Needs Attention'
      : 'Running';
  const browserSurfaceSubtitle = sidebarSurface === 'workflows'
    ? workflowsSubtitle
    : sidebarSurface === 'attention'
      ? attentionSubtitle
      : runningSubtitle;

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
  const browserStatusToneClass = sidebarSurface === 'running'
    ? 'bg-blue-950/70 text-blue-100'
    : sidebarSurface === 'attention'
      ? 'bg-amber-950/70 text-amber-100'
      : 'bg-gray-800 text-gray-200';

  const relatedBrowserTasks = Array.from(miniDagTasks.values()).filter((task) =>
    sidebarSurface === 'workflows' || task.id !== selectedTask?.id,
  );

  const renderWorkflowsList = (): JSX.Element => (
    workflowEntries.length === 0 ? renderBrowserEmptyState('No workflows yet', 'Use the terminal to plan your first run.') : (
      <div className="overflow-y-auto p-3">
        <div className="space-y-1">
          {workflowEntries.map((entry) => {
            const selected = selectedWorkflow?.id === entry.workflow.id;
            return (
              <button
                key={entry.workflow.id}
                type="button"
                onClick={() => selectWorkflowById(entry.workflow.id)}
                className={`block w-full rounded-xl px-3 py-2 text-left transition-colors ${selected ? 'bg-gray-800 text-white ring-1 ring-gray-700' : 'text-gray-200 hover:bg-gray-900/80'}`}
              >
                <div className="truncate font-medium">{entry.workflow.name}</div>
                <div className="mt-1 text-xs text-gray-500">{entry.taskCount} task{entry.taskCount === 1 ? '' : 's'}</div>
                <div className="mt-1 text-xs text-gray-400">{formatWorkflowStatus(entry.workflow.status)}</div>
              </button>
            );
          })}
        </div>
      </div>
    )
  );

  const renderTaskList = (entries: typeof attentionEntries, emptyTitle: string, emptyCopy: string, tone: 'attention' | 'running'): JSX.Element => (
    entries.length === 0 ? renderBrowserEmptyState(emptyTitle, emptyCopy) : (
      <div className="overflow-y-auto p-3">
        <div className="space-y-1">
          {entries.map((entry) => {
            const selected = selectedTask?.id === entry.task.id;
            const accent = tone === 'attention'
              ? selected ? 'bg-amber-950/50 text-amber-50 ring-1 ring-amber-800/60' : 'text-gray-200 hover:bg-gray-900/80'
              : selected ? 'bg-blue-950/50 text-blue-50 ring-1 ring-blue-800/60' : 'text-gray-200 hover:bg-gray-900/80';
            return (
              <button
                key={entry.task.id}
                type="button"
                onClick={() => selectTaskById(entry.task.id)}
                className={`block w-full rounded-xl px-3 py-2 text-left transition-colors ${accent}`}
              >
                <div className="truncate font-medium">{entry.task.description || entry.task.id}</div>
                <div className="mt-1 text-xs text-gray-500">{entry.workflow?.name ?? 'No workflow'}</div>
                <div className="mt-1 text-xs text-gray-400">{formatTaskStatus(entry.task.status)}</div>
              </button>
            );
          })}
        </div>
      </div>
    )
  );


  const renderPlanningSessionList = (): JSX.Element => (
    <div className="overflow-y-auto p-3">
      <div className="space-y-1">
        {planningSessions.map((session) => {
          const selected = session.id === activePlanningSession.id;
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => setActivePlanningSessionId(session.id)}
              className={`block w-full rounded-xl px-3 py-2 text-left transition-colors ${selected ? 'bg-gray-800 text-white ring-1 ring-gray-700' : 'text-gray-200 hover:bg-gray-900/80'}`}
            >
              <div className="truncate font-medium">{session.title}</div>
              <div className="mt-1 truncate text-xs text-gray-500">{previewPlanningMessage(session)}</div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${planningStatusClass(session.status)}`}>
                  {planningStatusLabel(session.status)}
                </span>
                <span className="shrink-0 text-[11px] text-gray-500">{relativePlanningUpdatedAt(session.updatedAt)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );

  const planningReadyCount = planningSessions.filter((session) => session.status === 'draft_ready').length;

  const renderPlanningTerminalSurface = (): JSX.Element => (
    <div className="flex-1 flex overflow-hidden">
      <div data-testid="planning-session-rail" className="flex h-full w-64 shrink-0 flex-col border-r border-gray-800 bg-gray-950/45">
        <div className="flex items-start justify-between gap-3 border-b border-gray-800 px-4 py-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-100">Planning Terminal</h2>
            <p className="mt-1 text-xs text-gray-500">
              {planningSessions.length} chat{planningSessions.length === 1 ? '' : 's'}
              {planningReadyCount > 0 ? ` · ${planningReadyCount} ready` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={handleCreatePlanningSession}
            className="rounded-lg border border-gray-700 px-2 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
          >
            New chat
          </button>
        </div>
        <div className="min-h-0 flex-1">{renderPlanningSessionList()}</div>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="border-b border-gray-800 bg-gray-950/50 px-4 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-100">{activePlanningSession.title}</h2>
              <p className="mt-1 text-sm text-gray-400">Planning chat window</p>
              <div className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium ${planningStatusClass(activePlanningSession.status)}`}>
                {planningStatusLabel(activePlanningSession.status)}
              </div>
            </div>
            <button
              type="button"
              aria-label="Return home"
              onClick={handleDismissBrowserSurface}
              className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
            >
              Home
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto bg-gray-900 p-4">
          <InvokerTerminal
            activeConversationKey={activePlanningConversationKey}
            lines={terminalLines}
            busy={activePlanningSessionBusy}
            value={planningInput}
            selectedPresetKey={selectedPlanningPresetKey}
            presetOptions={planningPresetOptions}
            draftPlanAvailable={draftPlanAvailable}
            draftPlanSummary={draftPlanSummary}
            submitError={planningSubmitError}
            readOnly={activePlanningSessionSubmitted}
            onValueChange={setPlanningInput}
            onSubmit={() => void handlePlanningSubmit()}
            onSubmitDraft={() => void handlePlanningSubmitDraft()}
            onPresetChange={setSelectedPlanningPresetKey}
            onExpand={() => setPlanningTerminalExpanded(true)}
          />
        </div>
      </div>
    </div>
  );
  const renderBrowserRail = (): JSX.Element => (
    <div data-testid="browser-rail" className="flex h-full w-64 shrink-0 flex-col border-r border-gray-800 bg-gray-950/45">
      <div className="flex items-start justify-between gap-3 border-b border-gray-800 px-4 py-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-100">{browserSurfaceTitle}</h2>
          <p className="mt-1 text-xs text-gray-500">{browserSurfaceSubtitle}</p>
        </div>
        <button
          type="button"
          aria-label="Close browser panel"
          data-testid="browser-rail-dismiss"
          onClick={handleDismissBrowserSurface}
          className="rounded-lg border border-gray-700 px-2 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
        >
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {sidebarSurface === 'workflows'
          ? renderWorkflowsList()
          : sidebarSurface === 'attention'
            ? renderTaskList(attentionEntries, 'All clear', 'Nothing needs a decision right now.', 'attention')
            : renderTaskList(runningEntries, 'No tasks running', 'Start a run to watch live work here.', 'running')}
      </div>
    </div>
  );
  const renderGraphTerminalChrome = (): JSX.Element => (
    <div
      data-testid="graph-terminal-chrome"
      data-keyboard-region="bottomBar"
      tabIndex={0}
      data-keyboard-active={keyboardRegion === 'bottomBar' ? 'true' : 'false'}
      className={`outline-none ${keyboardRegion === 'bottomBar' ? 'ring-2 ring-inset ring-blue-400/50' : ''}`}
    >
      {sidebarSurface === 'home' && (
        <WorkflowStatusChips
          workflows={workflows}
          activeFilters={statusFilters}
          keyboardActiveKey={keyboardRegion === 'bottomBar' ? visibleStatusKeys[bottomStatusIndex] ?? null : null}
          onStatusClick={handleStatusClick}
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
      <div className="border-b border-gray-800 bg-gray-950/50 px-4 py-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-100">{browserSelectedTitle}</h2>
            <p className="mt-1 text-sm text-gray-400">{browserSelectedContext}</p>
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
              className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
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
    ? 'Your plan will appear here.'
    : selectedWorkflow
      ? `${selectedWorkflow.name} · ${formatWorkflowStatus(selectedWorkflow.status)}`
      : `${workflowEntries.length} workflow${workflowEntries.length === 1 ? '' : 's'} ready`;
  return (
    <div className="h-screen flex flex-col bg-gray-900 text-gray-100" onClick={() => closeContextMenu()}>
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
            <button
              onClick={() => { cancelPendingSystemSetupAutoOpen(); setShowSystemSetup(true); }}
              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded text-xs font-medium transition-colors"
            >
              Open Setup
            </button>
            <button
              onClick={() => { cancelPendingSystemSetupAutoOpen(); setShowSystemBanner(false); }}
              className="px-2 py-1 text-amber-200 hover:text-white text-xs"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {runtimeStatus?.readOnly && (
        <div
          role="status"
          aria-live="polite"
          data-testid="read-only-mode-banner"
          className="border-b border-blue-700 bg-blue-950/70 px-4 py-2 text-sm text-blue-100"
        >
          <span className="font-semibold text-blue-50">Read-only mode.</span>{' '}
          This window can browse workflows, but it cannot make changes until the write owner is available.
        </div>
      )}


      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        <LeftStatusColumn
          workflows={workflows}
          tasks={tasks}
          queueStatus={queueStatus}
          workerStatus={workerStatus}
          planningSessionCount={planningSessions.length}
          selectedSurface={sidebarSurface}
          collapsed={sidebarCollapsed}
          onSelectSurface={handleSelectSidebarSurface}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
          onOpenSettings={() => {
            cancelPendingSystemSetupAutoOpen();
            setShowSystemSetup(true);
          }}
        />

        <div className="flex-1 flex overflow-hidden">
          <main className="flex-1 flex flex-col overflow-hidden bg-gray-900">
            {sidebarSurface === 'home' ? (
              renderGraphWorkspace('Plan graph', homeSubtitle, true)
            ) : sidebarSurface === 'planning' ? (
              renderPlanningTerminalSurface()
            ) : (
              <div className="flex-1 flex overflow-hidden">
                {renderBrowserRail()}
                {renderBrowserDetailWorkspace()}
              </div>
            )}

            {sidebarSurface === 'home' && viewMode === 'dag' && renderGraphTerminalChrome()}
          </main>

          {sidebarSurface !== 'planning' && (
            <div
              data-testid="workflow-inspector-shell"
              data-keyboard-region="inspector"
              tabIndex={0}
              data-keyboard-active={keyboardRegion === 'inspector' ? 'true' : 'false'}
              className={`${showEmptyGraphTutorial || showInspectorPlaceholder ? 'w-96' : effectiveInspectorCollapsed ? 'w-16' : 'w-96'} transition-all duration-150 outline-none ${keyboardRegion === 'inspector' ? 'ring-2 ring-inset ring-blue-400/50' : ''}`}
            >
              {showEmptyGraphTutorial ? (
                <EmptyGraphTutorial />
              ) : showInspectorPlaceholder ? (
                <EmptyInspectorPlaceholder />
              ) : showWorkerDetailsPanel ? (
                <WorkerDetailsPanel
                  worker={selectedWorker}
                  tasks={tasks}
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
                  collapsed={effectiveInspectorCollapsed}
                  advancedExpanded={advancedMetadataExpanded}
                  remoteTargets={remoteTargets}
                  executionPools={executionPools}
                  executionAgents={executionAgents}
                  onApprove={openApprovalModal}
                  onReject={openRejectModal}
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
          className="fixed inset-0 z-50 flex flex-col bg-gray-950"
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
            submitError={planningSubmitError}
            expanded
            onValueChange={setPlanningInput}
            readOnly={activePlanningSessionSubmitted}
            onSubmit={() => void handlePlanningSubmit()}
            onSubmitDraft={() => void handlePlanningSubmitDraft()}
            onPresetChange={setSelectedPlanningPresetKey}
            onExpand={() => setPlanningTerminalExpanded(true)}
            onCloseExpanded={() => setPlanningTerminalExpanded(false)}
          />
        </div>
      )}

      {graphMaximized && (
        <div
          data-testid="graph-maximized-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Full graph"
          className="fixed inset-0 z-50 flex flex-col bg-gray-950"
        >
          <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-100">Full graph</h2>
              <p className="text-xs text-gray-500">Press Escape to return.</p>
            </div>
            <button
              type="button"
              onClick={() => setGraphMaximized(false)}
              className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
            >
              Close
            </button>
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
                onManualViewport={handleManualViewport}
                statusFilters={new Set<string>()}
                runningTaskIds={runningTaskIds}
                surfaceMode="overlay"
              />
            ) : (
              <WorkflowGraph
                workflows={workflows}
                selectedWorkflowId={selectedWorkflow?.id ?? null}
                cameraCommand={cameraCommand}
                statusFilters={statusFilters}
                coreActivityByWorkflow={coreActivityByWorkflow}
                onSelectWorkflow={handleWorkflowClick}
                onWorkflowContextMenu={handleWorkflowContextMenu}
                onManualViewport={handleManualViewport}
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
            className="w-full max-w-2xl overflow-hidden rounded-lg border border-gray-700 bg-gray-900 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <input
              ref={searchInputRef}
              data-testid="keyboard-search-input"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search workflows, tasks, summaries, commands, or PRs"
              className="w-full border-b border-gray-800 bg-gray-950 px-4 py-3 text-sm text-gray-100 outline-none placeholder:text-gray-500"
            />
            <div
              role="listbox"
              data-testid="keyboard-search-results"
              className="max-h-[360px] overflow-auto py-1"
            >
              {searchQuery.trim() && searchResults.length === 0 && (
                <div className="px-4 py-6 text-center text-sm text-gray-500">No matches</div>
              )}
              {!searchQuery.trim() && (
                <div className="px-4 py-6 text-center text-sm text-gray-500">Start typing to search workflows and tasks</div>
              )}
              {searchResults.map((result, index) => (
                <button
                  key={`${result.kind}:${result.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === searchActiveIndex}
                  data-testid={`keyboard-search-result-${result.kind}-${result.id}`}
                  className={`flex w-full flex-col px-4 py-2 text-left text-sm ${index === searchActiveIndex ? 'bg-blue-600/25 text-white' : 'text-gray-200 hover:bg-gray-800'}`}
                  onMouseEnter={() => setSearchActiveIndex(index)}
                  onClick={() => activateSearchResult(result)}
                >
                  <span className="truncate font-medium">{result.title}</span>
                  <span className="truncate text-xs text-gray-400">{result.subtitle}</span>
                </button>
              ))}
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
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-gray-600 bg-gray-800 px-4 py-2 text-sm text-gray-100 shadow-xl"
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

