/**
 * App — Main layout for Invoker UI.
 *
 * Layout:
 * - Left rail: workflow controls and navigation
 * - Main: workflow graph / task DAG
 * - Right: workflow inspector
 * - Bottom: status chips and terminal drawer
 * - Modals overlay when needed
 */

import { useState, useCallback, useMemo, useEffect, useRef, useLayoutEffect } from 'react';
import yaml from 'js-yaml';
import type { TaskState, TaskReplacementDef, ExternalGatePolicyUpdate, WorkflowMeta, WorkflowStatus } from './types.js';
import type { ActionGraphNode, TerminalSessionDescriptor } from '@invoker/contracts';
import { useTasks } from './hooks/useTasks.js';
import { useQueueStatus } from './hooks/useQueueStatus.js';
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
import { ActionGraphView } from './components/ActionGraphView.js';
import { WorkflowStatusChips } from './components/WorkflowStatusChips.js';
import { TerminalDrawer, type TerminalDrawerState } from './components/TerminalDrawer.js';
import {
  isExperimentSpawnPivotTask,
  EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE,
} from './isExperimentSpawnPivot.js';
import { parsePlanText } from './lib/plan-parser.js';
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
type WorkflowDetachFeedback = {
  workflowId: string;
  upstreamWorkflowId: string;
  message: string;
  kind: 'success' | 'error';
};
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

function workflowIdentity(workflow: WorkflowMeta | undefined, workflowId: string): string {
  if (!workflow) return workflowId;
  const name = workflow.name || workflow.id;
  return name === workflow.id ? workflow.id : `${name} (${workflow.id})`;
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
  onCopyWorkflowId: (workflowId: string) => void;
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
  onCopyWorkflowId,
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

function GearIcon(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
    >
      <path d="M6.9 2.2h2.2l.4 1.6a4.7 4.7 0 0 1 1.1.6l1.6-.5 1.1 1.9-1.2 1.1a4.8 4.8 0 0 1 0 1.3l1.2 1.1-1.1 1.9-1.6-.5a4.7 4.7 0 0 1-1.1.6l-.4 1.6H6.9l-.4-1.6a4.7 4.7 0 0 1-1.1-.6l-1.6.5-1.1-1.9 1.2-1.1a4.8 4.8 0 0 1 0-1.3L2.7 5.8l1.1-1.9 1.6.5a4.7 4.7 0 0 1 1.1-.6l.4-1.6Z" />
      <circle cx="8" cy="7.5" r="1.7" />
    </svg>
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
  const invoker = useInvoker();
  const queueStatus = useQueueStatus();
  const runningTaskIds = useMemo(
    () => new Set((queueStatus?.running ?? []).map((entry) => entry.taskId)),
    [queueStatus],
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const graphSurfaceRef = useRef<HTMLDivElement>(null);
  const lastGoodSelectedWorkflowGraphRef = useRef<SelectedWorkflowGraphSnapshot | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [stickySelectedWorkflow, setStickySelectedWorkflow] = useState<WorkflowMeta | null>(null);
  const [workflowSelectionDismissed, setWorkflowSelectionDismissed] = useState(false);
  const [modal, setModal] = useState<ModalState>({ type: 'none' });
  const [hasLoadedPlan, setHasLoadedPlan] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [planName, setPlanName] = useState<string | null>(null);
  const [onFinish, setOnFinish] = useState<'none' | 'merge' | 'pull_request'>('merge');
  const [viewMode, setViewMode] = useState<'dag' | 'history' | 'timeline' | 'queue' | 'actionGraph'>('dag');
  const [selectedActionNode, setSelectedActionNode] = useState<ActionGraphNode | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [remoteTargets, setRemoteTargets] = useState<string[]>([]);
  const [executionPools, setExecutionPools] = useState<string[]>([]);
  const [executionAgents, setExecutionAgents] = useState<string[]>([]);
  const [statusFilters, setStatusFilters] = useState<Set<WorkflowStatus>>(new Set());
  const [systemDiagnostics, setSystemDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [showSystemSetup, setShowSystemSetup] = useState(false);
  const [showSystemBanner, setShowSystemBanner] = useState(false);
  const [installSkillsPending, setInstallSkillsPending] = useState(false);
  const [installSkillsError, setInstallSkillsError] = useState<string | null>(null);
  const [updateCliPending, setUpdateCliPending] = useState(false);
  const [updateCliError, setUpdateCliError] = useState<string | null>(null);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [advancedMetadataExpanded, setAdvancedMetadataExpanded] = useState(false);
  const [terminalDrawerState, setTerminalDrawerState] = useState<TerminalDrawerState>('minimized');
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionDescriptor[]>([]);
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<string | null>(null);
  const [workflowContextMenu, setWorkflowContextMenu] = useState<WorkflowContextMenuState | null>(null);
  const [workflowDetachFeedback, setWorkflowDetachFeedback] = useState<WorkflowDetachFeedback | null>(null);
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
        setShowSystemSetup(true);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    window.invoker?.getRemoteTargets?.().then(setRemoteTargets).catch(() => {});
    window.invoker?.getExecutionPools?.().then(setExecutionPools).catch(() => {});
    window.invoker?.getExecutionAgents?.().then(setExecutionAgents).catch(() => {});
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

  const handleWorkflowContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>, workflowId: string) => {
    event.preventDefault();
    setWorkflowSelectionDismissed(false);
    setSelectedWorkflowId(workflowId);
    setSelectedTaskId(null);
    setContextMenu(null);
    setWorkflowContextMenu({ x: event.clientX, y: event.clientY, workflowId });
  }, []);

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
      await invoker.restartTask(taskId);
    } catch (err) {
      console.error('Failed to restart task:', err);
    }
  }, [invoker]);

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
      await window.invoker?.replaceTask(taskId, replacements);
    } catch (err) {
      console.error('Failed to replace task:', err);
    }
  }, []);

  const handleRebaseRetry = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.rebaseRetry(workflowId);
      if (result && !result.success) {
        console.error('Rebase and Retry failed for some branches:', result.errors);
      }
    } catch (err) {
      console.error('Rebase and Retry failed:', err);
    }
  }, []);

  const handleRebaseRecreate = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.rebaseRecreate(workflowId);
      if (result && !result.success) {
        console.error('Rebase and Recreate failed for some branches:', result.errors);
      }
    } catch (err) {
      console.error('Rebase and Recreate failed:', err);
    }
  }, []);

  const handleRetryWorkflow = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    try {
      await window.invoker?.retryWorkflow(workflowId);
    } catch (err) {
      console.error('Retry Workflow failed:', err);
    }
  }, []);

  const handleRecreateWorkflow = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    try {
      await window.invoker?.recreateWorkflow(workflowId);
    } catch (err) {
      console.error('Recreate Workflow failed:', err);
    }
  }, []);

  const handleRecreateTask = useCallback(async (taskId: string) => {
    setContextMenu(null);
    try {
      await window.invoker?.recreateTask(taskId);
    } catch (err) {
      console.error('Recreate from Task failed:', err);
    }
  }, []);

  const handleRecreateDownstream = useCallback(async (taskId: string) => {
    setContextMenu(null);
    try {
      await window.invoker?.recreateDownstream(taskId);
    } catch (err) {
      console.error('Recreate Downstream failed:', err);
    }
  }, []);

  const handleDeleteWorkflow = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    const confirmed = window.confirm(
      'Delete this workflow and all its tasks? This cannot be undone.',
    );
    if (!confirmed) return;
    try {
      await window.invoker?.deleteWorkflow(workflowId);
      setSelectedTaskId(null);
      if (selectedWorkflowId === workflowId) {
        setSelectedWorkflowId(null);
      }
      refreshTaskGraph();
    } catch (err) {
      console.error('Delete Workflow failed:', err);
    }
  }, [refreshTaskGraph, selectedWorkflowId]);

  const handleDetachWorkflow = useCallback(async (workflowId: string, upstreamWorkflowId: string) => {
    setContextMenu(null);
    setWorkflowContextMenu(null);
    const downstreamIdentity = workflowIdentity(workflows.get(workflowId), workflowId);
    const upstreamIdentity = workflowIdentity(workflows.get(upstreamWorkflowId), upstreamWorkflowId);
    const confirmed = window.confirm(
      `Detach downstream workflow "${downstreamIdentity}" from upstream workflow "${upstreamIdentity}"?\n\n` +
      'This removes the active workflow dependency and may return the downstream workflow to pending.',
    );
    if (!confirmed) return;

    try {
      await window.invoker?.detachWorkflow(workflowId, upstreamWorkflowId);
      setWorkflowSelectionDismissed(false);
      setSelectedWorkflowId(workflowId);
      setWorkflowDetachFeedback({
        workflowId,
        upstreamWorkflowId,
        kind: 'success',
        message: `Detached ${downstreamIdentity} from ${upstreamIdentity}.`,
      });
      await refreshTaskGraph();
    } catch (err) {
      console.error('Detach Workflow failed:', err);
      setWorkflowDetachFeedback({
        workflowId,
        upstreamWorkflowId,
        kind: 'error',
        message: `Failed to detach ${downstreamIdentity} from ${upstreamIdentity}.`,
      });
    }
  }, [refreshTaskGraph, workflows]);

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
      if (hasMergeConflict) {
        await window.invoker?.resolveConflict(taskId, agentName);
      } else {
        await window.invoker?.fixWithAgent(taskId, agentName);
      }
      refreshTaskGraph();
    } catch (err) {
      console.error('Fix failed:', err);
    }
  }, [tasks, refreshTaskGraph]);

  const handleCancelTask = useCallback(async (taskId: string) => {
    setContextMenu(null);
    const confirmed = window.confirm(
      `Terminate task "${taskId}" and all downstream dependents?`
    );
    if (!confirmed) return;
    try {
      await window.invoker?.cancelTask(taskId);
    } catch (err) {
      console.error('Failed to cancel task:', err);
    }
  }, []);

  const handleCancelWorkflow = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    const confirmed = window.confirm(
      `Cancel workflow "${workflowId}"? This cancels all active tasks in this workflow.`
    );
    if (!confirmed) return;
    try {
      await window.invoker?.cancelWorkflow(workflowId);
    } catch (err) {
      console.error('Failed to cancel workflow:', err);
    }
  }, []);

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
    issueCameraCommand({ kind: 'fitInitial', scope: 'workflow', reason: 'manual-refresh' });
  }, [issueCameraCommand, refreshTaskGraph]);

  // ── Plan loading ──────────────────────────────────────────
  const handleLoadPlan = useCallback(
    async (planText: string) => {
      if (!invoker) return;
      try {
        await invoker.loadPlan(planText);
        setWorkflowSelectionDismissed(false);
        setHasLoadedPlan(true);
        // Parse locally just for UI display state
        const parsed = yaml.load(planText) as any;
        setPlanName(parsed?.name ?? 'Untitled Plan');
        setOnFinish(parsed?.onFinish ?? 'merge');
        refreshTaskGraph();
      } catch (err) {
        console.error('Failed to load plan:', err);
      }
    },
    [invoker, refreshTaskGraph],
  );

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const text = await file.text();
      const dotIndex = file.name.lastIndexOf('.');
      const ext = dotIndex >= 0 ? file.name.slice(dotIndex).toLowerCase() : undefined;

      try {
        parsePlanText(text, ext);
        await handleLoadPlan(text);
      } catch (err) {
        console.error('Failed to parse plan file:', err);
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [handleLoadPlan],
  );

  const handleStart = useCallback(async () => {
    if (!invoker) return;
    try {
      await invoker.start();
      setHasStarted(true);
    } catch (err) {
      console.error('Failed to start:', err);
    }
  }, [invoker]);

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
      setOnFinish('merge');
      setSelectedTaskId(null);
      setSelectedWorkflowId(null);
      setModal({ type: 'none' });
      setStatusFilters(new Set<WorkflowStatus>());
    } catch (err) {
      console.error('Failed to clear:', err);
    }
  }, [invoker, clearTasks]);

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
      setSelectedTaskId(null);
      setSelectedWorkflowId(null);
      setModal({ type: 'none' });
    } catch (err) {
      console.error('Failed to delete workflows:', err);
    }
  }, [invoker, clearTasks]);

  // True when all tasks have reached a terminal state.
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

  // ── Task actions ──────────────────────────────────────────
  const handleProvideInput = useCallback(
    async (taskId: string, input: string) => {
      if (!invoker) return;
      await invoker.provideInput(taskId, input);
    },
    [invoker],
  );

  const handleApprove = useCallback(
    async (taskId: string) => {
      if (!invoker) return;
      await invoker.approve(taskId);
    },
    [invoker],
  );

  const handleReject = useCallback(
    async (taskId: string, reason?: string) => {
      if (!invoker) return;
      await invoker.reject(taskId, reason);
    },
    [invoker],
  );

  const handleSelectExperiment = useCallback(
    async (taskId: string, experimentIds: string[]) => {
      if (!invoker) return;
      await invoker.selectExperiment(taskId, experimentIds.length === 1 ? experimentIds[0] : experimentIds);
    },
    [invoker],
  );

  // ── Edit task command ──────────────────────────────────────
  const handleEditCommand = useCallback(
    async (taskId: string, newCommand: string) => {
      if (!invoker) return;
      try {
        await invoker.editTaskCommand(taskId, newCommand);
      } catch (err) {
        console.error('Failed to edit task command:', err);
      }
    },
    [invoker],
  );

  // ── Edit task prompt ───────────────────────────────────────
  const handleEditPrompt = useCallback(
    async (taskId: string, newPrompt: string) => {
      if (!invoker) return;
      try {
        await invoker.editTaskPrompt(taskId, newPrompt);
      } catch (err) {
        console.error('Failed to edit task prompt:', err);
      }
    },
    [invoker],
  );

  // ── Edit task executor type ───────────────────────────────
  const handleEditType = useCallback(
    async (taskId: string, runnerKind: string, poolMemberId?: string) => {
      if (!invoker) return;
      try {
        await invoker.editTaskType(taskId, runnerKind, poolMemberId);
      } catch (err) {
        console.error('Failed to edit task type:', err);
      }
    },
    [invoker],
  );

  // ── Edit task execution pool ─────────────────────────────
  const handleEditPool = useCallback(
    async (taskId: string, poolId: string) => {
      if (!invoker) return;
      try {
        await invoker.editTaskPool(taskId, poolId);
      } catch (err) {
        console.error('Failed to edit task pool:', err);
      }
    },
    [invoker],
  );

  // ── Edit task execution agent ────────────────────────────
  const handleEditAgent = useCallback(
    async (taskId: string, agentName: string) => {
      if (!invoker) return;
      try {
        await invoker.editTaskAgent(taskId, agentName);
      } catch (err) {
        console.error('Failed to edit task agent:', err);
      }
    },
    [invoker],
  );

  const handleSetExternalGatePolicies = useCallback(
    async (taskId: string, updates: ExternalGatePolicyUpdate[]) => {
      if (!invoker) return;
      try {
        await invoker.setTaskExternalGatePolicies(taskId, updates);
      } catch (err) {
        console.error('Failed to set external gate policies:', err);
      }
    },
    [invoker],
  );

  const handleSetMergeBranch = useCallback(
    async (workflowId: string, baseBranch: string) => {
      if (!invoker) return;
      try {
        await invoker.setMergeBranch(workflowId, baseBranch);
        refreshTaskGraph();
      } catch (err) {
        console.error('Failed to set merge branch:', err);
      }
    },
    [invoker, refreshTaskGraph],
  );

  const handleSetMergeMode = useCallback(
    async (workflowId: string, mergeMode: 'manual' | 'automatic' | 'external_review') => {
      if (!invoker) return;
      try {
        await invoker.setMergeMode(workflowId, mergeMode);
        refreshTaskGraph();
      } catch (err) {
        console.error('Failed to set merge mode:', err);
      }
    },
    [invoker, refreshTaskGraph],
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

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-gray-100" onClick={() => closeContextMenu()}>
      {showSystemBanner && (
        <div className="px-4 py-3 border-b border-amber-700 bg-amber-950/50 flex items-center justify-between gap-4">
          <div className="text-sm text-amber-100">
            {missingRequiredTool
              ? `${missingRequiredTool.name} is missing. Invoker needs it for local workflows.`
              : needsBundledSkillsPrompt
                ? 'Bundled Invoker skills are ready to install into Codex. Install them before using packaged skill-driven flows.'
              : installedAgentCount === 0
                ? 'No Claude or Codex CLI detected yet. Install one before running agent-backed tasks.'
                : 'Review local prerequisites before running packaged workflows.'}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowSystemSetup(true)}
              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded text-xs font-medium transition-colors"
            >
              Open Setup
            </button>
            <button
              onClick={() => setShowSystemBanner(false)}
              className="px-2 py-1 text-amber-200 hover:text-white text-xs"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        <nav className="w-24 border-r border-gray-800 bg-gray-950/60 flex flex-col justify-between py-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.yaml,.yml"
            onChange={handleFileSelect}
            className="hidden"
          />
          <div className="space-y-3 px-2">
            <div className="space-y-1">
              <button
                data-testid="rail-open-file"
                onClick={() => fileInputRef.current?.click()}
                className="w-full rounded bg-gray-700 px-2 py-1.5 text-left text-xs font-medium text-gray-100 hover:bg-gray-600"
              >
                Open
              </button>
              {showStart && (
                <button
                  data-testid="rail-start"
                  onClick={handleStart}
                  className="w-full rounded bg-green-700 px-2 py-1.5 text-left text-xs font-medium text-white hover:bg-green-600"
                >
                  Start
                </button>
              )}
              {showStop && (
                <button
                  data-testid="rail-stop"
                  onClick={handleStop}
                  className="w-full rounded bg-red-700 px-2 py-1.5 text-left text-xs font-medium text-white hover:bg-red-600"
                >
                  Stop
                </button>
              )}
              {planName && (
                <div className="truncate px-1 pt-1 text-[10px] leading-tight text-gray-500" title={planName}>
                  {planName}
                </div>
              )}
            </div>

            <div className="space-y-1">
            <button
              data-testid="rail-home"
              onClick={() => {
                setViewMode('dag');
              }}
              className={`w-full rounded px-2 py-1.5 text-left text-xs ${viewMode === 'dag' ? 'bg-gray-800 text-white' : 'text-gray-300 hover:bg-gray-800/70'}`}
            >
              Home
            </button>
            <button
              data-testid="rail-timeline"
              onClick={() => {
                setViewMode('timeline');
              }}
              className={`w-full rounded px-2 py-1.5 text-left text-xs ${viewMode === 'timeline' ? 'bg-gray-800 text-white' : 'text-gray-300 hover:bg-gray-800/70'}`}
            >
              Timeline
            </button>
            <button
              data-testid="rail-history"
              onClick={() => {
                setViewMode('history');
              }}
              className={`w-full rounded px-2 py-1.5 text-left text-xs ${viewMode === 'history' ? 'bg-gray-800 text-white' : 'text-gray-300 hover:bg-gray-800/70'}`}
            >
              History
            </button>
            <button
              data-testid="rail-action-graph"
              onClick={() => {
                setViewMode('actionGraph');
                setWorkflowSelectionDismissed(true);
                setSelectedTaskId(null);
              }}
              className={`w-full rounded px-2 py-1.5 text-left text-xs ${viewMode === 'actionGraph' ? 'bg-gray-800 text-white' : 'text-gray-300 hover:bg-gray-800/70'}`}
            >
              Action Graph
            </button>
            <button
              data-testid="rail-queue"
              onClick={() => {
                setViewMode('queue');
              }}
              className={`w-full rounded px-2 py-1.5 text-left text-xs ${viewMode === 'queue' ? 'bg-gray-800 text-white' : 'text-gray-300 hover:bg-gray-800/70'}`}
            >
              Queue
            </button>
            </div>

            <div className="space-y-1 border-t border-gray-800 pt-3">
              <button
                data-testid="rail-refresh"
                onClick={handleRefresh}
                className="w-full rounded px-2 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800/70"
              >
                Refresh
              </button>
              <button
                data-testid="rail-clear"
                onClick={handleClear}
                className="w-full rounded px-2 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-800/70"
              >
                Clear
              </button>
              <button
                data-testid="rail-delete-history"
                onClick={handleDeleteDB}
                className="w-full rounded px-2 py-1.5 text-left text-xs text-red-300 hover:bg-red-950/50"
              >
                Delete
              </button>
            </div>
          </div>
          <div className="px-2">
            <button
              data-testid="rail-settings"
              onClick={() => setShowSystemSetup(true)}
              className="flex h-8 w-full items-center justify-center rounded text-gray-300 hover:bg-gray-800/70 hover:text-white"
              aria-label="Settings"
              title="Settings"
            >
              <GearIcon />
            </button>
          </div>
        </nav>

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 flex flex-col overflow-hidden">
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
                  queueStatus={queueStatus}
                  onTaskClick={handleTaskClick}
                  onCancel={handleCancelTask}
                  selectedTaskId={selectedTaskId}
                />
              ) : viewMode === 'history' ? (
                <HistoryView onTaskClick={handleTaskClick} selectedTaskId={selectedTaskId} />
              ) : viewMode === 'timeline' ? (
                <TimelineView tasks={tasks} onTaskClick={handleTaskClick} selectedTaskId={selectedTaskId} />
              ) : viewMode === 'actionGraph' ? (
                <ActionGraphView
                  selectedNodeId={selectedActionNode?.id ?? null}
                  onSelectNode={(node) => {
                    setSelectedActionNode(node);
                    if (node?.taskId) setSelectedTaskId(node.taskId);
                    if (node?.workflowId) setSelectedWorkflowId(node.workflowId);
                  }}
                />
              ) : (
                <>
                  <WorkflowGraph
                    workflows={workflows}
                    selectedWorkflowId={selectedWorkflow?.id ?? null}
                    cameraCommand={cameraCommand}
                    statusFilters={statusFilters}
                    onSelectWorkflow={handleWorkflowClick}
                    onWorkflowContextMenu={handleWorkflowContextMenu}
                    onManualViewport={handleManualViewport}
                  />
                  {displayedSelectedWorkflowGraph !== null && (
                    <FloatingGraphPanel
                      key={displayedSelectedWorkflowGraph.workflow.id}
                      testId="selected-workflow-mini-dag"
                      dragHandleTestId="selected-workflow-mini-dag-drag-handle"
                      title={`${displayedSelectedWorkflowGraph.workflow.name} task DAG`}
                      boundsRef={graphSurfaceRef}
                      contentClassName="h-[250px]"
                    >
                      <div
                        data-keyboard-region="taskGraph"
                        tabIndex={0}
                        data-keyboard-active={keyboardRegion === 'taskGraph' ? 'true' : 'false'}
                        className={`h-full outline-none ${keyboardRegion === 'taskGraph' ? 'ring-2 ring-inset ring-blue-300/60' : ''}`}
                      >
                        {isSelectedWorkflowGraphRefreshing && (
                          <div data-testid="selected-workflow-mini-dag-refreshing" className="px-2 py-1 text-xs text-amber-200">
                            Refreshing graph…
                          </div>
                        )}
                        <TaskDAG
                          tasks={displayedSelectedWorkflowGraph.tasks}
                          workflows={selectedTaskDagWorkflows}
                          selectedTaskId={selectedTaskId}
                          cameraCommand={cameraCommand}
                          onTaskClick={handleTaskClick}
                          onTaskDoubleClick={handleTaskDoubleClick}
                          onTaskContextMenu={handleTaskContextMenu}
                          onManualViewport={handleManualViewport}
                          statusFilters={new Set()}
                          runningTaskIds={runningTaskIds}
                        />
                      </div>
                    </FloatingGraphPanel>
                  )}
                </>
              )}
            </div>

            {viewMode === 'dag' && (
              <div
                data-keyboard-region="bottomBar"
                tabIndex={0}
                data-keyboard-active={keyboardRegion === 'bottomBar' ? 'true' : 'false'}
                className={`outline-none ${keyboardRegion === 'bottomBar' ? 'ring-2 ring-inset ring-blue-400/50' : ''}`}
              >
                <WorkflowStatusChips
                  workflows={workflows}
                  activeFilters={statusFilters}
                  keyboardActiveKey={keyboardRegion === 'bottomBar' ? visibleStatusKeys[bottomStatusIndex] ?? null : null}
                  onStatusClick={handleStatusClick}
                />
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
            )}
          </div>

          <div
            data-keyboard-region="inspector"
            tabIndex={0}
            data-keyboard-active={keyboardRegion === 'inspector' ? 'true' : 'false'}
            className={`${inspectorCollapsed ? 'w-16' : 'w-96'} transition-all duration-150 outline-none ${keyboardRegion === 'inspector' ? 'ring-2 ring-inset ring-blue-400/50' : ''}`}
          >
            <WorkflowInspector
              workflow={displayedSelectedWorkflowGraph?.workflow ?? selectedWorkflow}
              task={selectedTask}
              workflowTasks={displayedSelectedWorkflowGraph?.tasks ?? miniDagTasks}
              remoteTargets={remoteTargets}
              executionPools={executionPools}
              executionAgents={executionAgents}
              collapsed={inspectorCollapsed}
              advancedExpanded={advancedMetadataExpanded}
              actionNode={viewMode === 'actionGraph' ? selectedActionNode : null}
              onEditType={handleEditType}
              onEditPool={handleEditPool}
              onEditAgent={handleEditAgent}
              onEditPrompt={handleEditPrompt}
              onEditCommand={handleEditCommand}
              onApprove={openApprovalModal}
              onReject={openRejectModal}
              onSetMergeBranch={handleSetMergeBranch}
              onSetMergeMode={handleSetMergeMode}
              onDetachWorkflow={handleDetachWorkflow}
              workflows={workflows}
              detachFeedback={workflowDetachFeedback}
              onToggleCollapsed={() => setInspectorCollapsed((prev) => !prev)}
              onToggleAdvanced={() => setAdvancedMetadataExpanded((prev) => !prev)}
            />
          </div>
        </div>
      </div>

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
          updateCliError={updateCliError}
          onUpdateInvokerCli={handleUpdateInvokerCli}
          onClose={() => setShowSystemSetup(false)}
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
          onCopyWorkflowId={handleCopyWorkflowId}
          onClose={closeContextMenu}
          autoFocus={Boolean(workflowContextMenu.returnFocusRegion)}
        />
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
          onClose={closeContextMenu}
          autoFocus={Boolean(contextMenu.returnFocusRegion)}
        />
      )}
    </div>
  );
}
