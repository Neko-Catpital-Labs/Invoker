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
import type { TaskState, TaskReplacementDef, ExternalGatePolicyUpdate, WorkflowStatus } from './types.js';
import type { ActionGraphNode, TerminalSessionDescriptor } from '@invoker/contracts';
import { useTasks } from './hooks/useTasks.js';
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
import { StatusBar } from './components/StatusBar.js';
import { TerminalDrawer } from './components/TerminalDrawer.js';
import {
  isExperimentSpawnPivotTask,
  EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE,
} from './isExperimentSpawnPivot.js';
import { parsePlanText } from './lib/plan-parser.js';
import type { SystemDiagnostics } from '@invoker/contracts';

type ModalState =
  | { type: 'none' }
  | { type: 'input'; task: TaskState }
  | { type: 'approval'; task: TaskState; action: 'approve' | 'reject' }
  | { type: 'experiment'; task: TaskState }
  | { type: 'replace'; task: TaskState };

type KeyboardRegion = 'workflowGraph' | 'taskGraph' | 'inspector' | 'bottomBar';
type SearchResult =
  | { kind: 'workflow'; id: string; title: string; subtitle: string }
  | { kind: 'task'; id: string; workflowId: string | null; title: string; subtitle: string };

const KEYBOARD_REGION_ORDER: readonly KeyboardRegion[] = ['workflowGraph', 'taskGraph', 'inspector', 'bottomBar'];
const STATUS_KEY_ORDER: readonly string[] = [
  'completed',
  'running',
  'failed',
  'closed',
  'pending',
  'needs_input',
  'review_ready',
  'awaiting_approval',
  'blocked',
  'fixing_with_ai',
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
  onCopyWorkflowId: (workflowId: string) => void;
  onClose: () => void;
}

const WORKFLOW_MORE_ITEM_ID = '__more__';

interface WorkflowMenuItem {
  id: string;
  label: string;
  variant: 'default' | 'danger';
  run: (workflowId: string) => void;
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
}: WorkflowContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [showMore, setShowMore] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);

  const safeActions: WorkflowMenuItem[] = [
    { id: 'open-workflow', label: 'Open Workflow', variant: 'default', run: onOpenWorkflow },
    { id: 'open-pr', label: 'Open PR', variant: 'default', run: onOpenPr },
    { id: 'retry-workflow', label: 'Retry Workflow', variant: 'default', run: onRetryWorkflow },
    { id: 'copy-workflow-id', label: 'Copy Workflow ID', variant: 'default', run: onCopyWorkflowId },
  ];
  const dangerActions: WorkflowMenuItem[] = [
    { id: 'rebase-retry', label: 'Rebase and Retry', variant: 'default', run: onRebaseRetry },
    { id: 'rebase-recreate', label: 'Rebase and Recreate', variant: 'danger', run: onRebaseRecreate },
    { id: 'recreate-workflow', label: 'Recreate Workflow', variant: 'danger', run: onRecreateWorkflow },
    { id: 'cancel-workflow', label: 'Cancel Workflow', variant: 'danger', run: onCancelWorkflow },
    { id: 'delete-workflow', label: 'Delete Workflow', variant: 'danger', run: onDeleteWorkflow },
  ];

  type NavigableItem = WorkflowMenuItem | { id: typeof WORKFLOW_MORE_ITEM_ID; label: 'More' };
  const navigableItems: NavigableItem[] = showMore
    ? [...safeActions, ...dangerActions]
    : [...safeActions, { id: WORKFLOW_MORE_ITEM_ID, label: 'More' }];

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
    menuRef.current?.focus({ preventScroll: true });
  }, []);

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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('pointerdown', handlePointerDownCapture, true);
    document.addEventListener('mousedown', handleMouseDownCapture, true);
    document.addEventListener('click', handleClickCapture, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownCapture, true);
      document.removeEventListener('mousedown', handleMouseDownCapture, true);
      document.removeEventListener('click', handleClickCapture, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const activateItem = (item: NavigableItem) => {
    if (item.id === WORKFLOW_MORE_ITEM_ID) {
      setShowMore(true);
      // After expansion, highlight the first newly visible item, which sits
      // at the index immediately after the safe actions.
      setFocusedIndex(safeActions.length);
      return;
    }
    item.run(workflowId);
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Enter' &&
      event.key !== ' '
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const len = navigableItems.length;
      if (len === 0) return;
      const next = (focusedIndex + direction + len) % len;
      setFocusedIndex(next);
      return;
    }

    const item = navigableItems[focusedIndex];
    if (item) activateItem(item);
  };

  const buttonClass = 'w-full px-3 py-1.5 text-left text-sm text-gray-100 hover:bg-gray-700';
  const dangerButtonClass = 'w-full px-3 py-1.5 text-left text-sm text-red-300 hover:bg-gray-700';
  const moreButtonClass = 'w-full px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-gray-700';

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
      {navigableItems.map((item, idx) => {
        const isFocused = idx === focusedIndex;
        const focusedClass = isFocused ? 'bg-gray-700' : '';
        const needsDivider = idx === safeActions.length;

        if (item.id === WORKFLOW_MORE_ITEM_ID) {
          return (
            <div key={item.id}>
              {needsDivider && <div className="my-1 border-t border-gray-600" />}
              <button
                role="menuitem"
                className={`${moreButtonClass} ${focusedClass}`}
                onClick={() => activateItem(item)}
                onMouseEnter={() => setFocusedIndex(idx)}
              >
                {item.label}
              </button>
            </div>
          );
        }

        const baseClass = item.variant === 'danger' ? dangerButtonClass : buttonClass;
        return (
          <div key={item.id}>
            {needsDivider && <div className="my-1 border-t border-gray-600" />}
            <button
              role="menuitem"
              className={`${baseClass} ${focusedClass}`}
              onClick={() => activateItem(item)}
              onMouseEnter={() => setFocusedIndex(idx)}
            >
              {item.label}
            </button>
          </div>
        );
      })}
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

export function App() {
  const { tasks, workflows, clearTasks, refreshTasks } = useTasks();
  const invoker = useInvoker();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const graphSurfaceRef = useRef<HTMLDivElement>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [workflowSelectionDismissed, setWorkflowSelectionDismissed] = useState(false);
  const [modal, setModal] = useState<ModalState>({ type: 'none' });
  const [hasLoadedPlan, setHasLoadedPlan] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [planName, setPlanName] = useState<string | null>(null);
  const [onFinish, setOnFinish] = useState<'none' | 'merge' | 'pull_request'>('merge');
  const [viewMode, setViewMode] = useState<'dag' | 'history' | 'timeline' | 'queue' | 'actionGraph'>('dag');
  const [selectedActionNode, setSelectedActionNode] = useState<ActionGraphNode | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; taskId: string } | null>(null);
  const [remoteTargets, setRemoteTargets] = useState<string[]>([]);
  const [executionPools, setExecutionPools] = useState<string[]>([]);
  const [executionAgents, setExecutionAgents] = useState<string[]>([]);
  const [statusFilters, setStatusFilters] = useState<Set<WorkflowStatus>>(new Set());
  const [systemDiagnostics, setSystemDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [showSystemSetup, setShowSystemSetup] = useState(false);
  const [showSystemBanner, setShowSystemBanner] = useState(false);
  const [installSkillsPending, setInstallSkillsPending] = useState(false);
  const [installSkillsError, setInstallSkillsError] = useState<string | null>(null);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [advancedMetadataExpanded, setAdvancedMetadataExpanded] = useState(false);
  const [terminalCollapsed, setTerminalCollapsed] = useState(true);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionDescriptor[]>([]);
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState<string | null>(null);
  const [workflowContextMenu, setWorkflowContextMenu] = useState<{ x: number; y: number; workflowId: string } | null>(null);
  const [keyboardRegion, setKeyboardRegion] = useState<KeyboardRegion>('workflowGraph');
  const [previousGraphRegion, setPreviousGraphRegion] = useState<KeyboardRegion>('workflowGraph');
  const [centerWorkflowId, setCenterWorkflowId] = useState<string | null>(null);
  const [centerTaskId, setCenterTaskId] = useState<string | null>(null);
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
  const selectedWorkflow = useMemo(() => {
    if (selectedWorkflowId) {
      return workflows.get(selectedWorkflowId) ?? null;
    }
    if (selectedTask?.config.workflowId) {
      return workflows.get(selectedTask.config.workflowId) ?? null;
    }
    return null;
  }, [selectedWorkflowId, selectedTask, workflows]);
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
    if (selectedTask?.config.workflowId) {
      setWorkflowSelectionDismissed(false);
      setSelectedWorkflowId(selectedTask.config.workflowId);
      return;
    }
    if (selectedWorkflowId && workflows.has(selectedWorkflowId)) {
      return;
    }
    if (workflowSelectionDismissed) {
      return;
    }
    const firstWorkflowId = workflows.keys().next().value as string | undefined;
    setSelectedWorkflowId(firstWorkflowId ?? null);
  }, [selectedTask, selectedWorkflowId, workflowSelectionDismissed, workflows]);

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
    const counts = new Map<string, number>();
    for (const task of tasks.values()) {
      const key = task.status === 'awaiting_approval' && task.execution.pendingFixError ? 'fix_approval' : task.status;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return STATUS_KEY_ORDER.filter((key) => key === 'completed' || key === 'running' || key === 'failed' || key === 'pending' || (counts.get(key) ?? 0) > 0);
  }, [tasks]);

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
      document.querySelector<HTMLElement>(`[data-keyboard-region="${region}"]`)?.focus();
    });
  }, []);

  const nodeCenter = useCallback((element: Element | null) => {
    const rect = element?.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) {
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return { x: Math.max(24, window.innerWidth / 2), y: Math.max(24, window.innerHeight / 2) };
  }, []);

  const selectWorkflowById = useCallback((workflowId: string) => {
    setWorkflowSelectionDismissed(false);
    setSelectedWorkflowId(workflowId);
    setSelectedTaskId(null);
    setContextMenu(null);
    setWorkflowContextMenu(null);
    setCenterWorkflowId(workflowId);
    focusKeyboardRegion('workflowGraph');
  }, [focusKeyboardRegion]);

  const selectTaskById = useCallback((taskId: string) => {
    const task = tasks.get(taskId);
    if (!task) return;
    setSelectedTaskId(task.id);
    setWorkflowSelectionDismissed(false);
    if (task.config.workflowId) {
      setSelectedWorkflowId(task.config.workflowId);
      setCenterWorkflowId(task.config.workflowId);
    }
    setContextMenu(null);
    setWorkflowContextMenu(null);
    setCenterTaskId(task.id);
    focusKeyboardRegion('taskGraph');
  }, [focusKeyboardRegion, tasks]);

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
      setContextMenu({ x: point.x, y: point.y, taskId: selectedTaskId });
      return;
    }
    const workflowId = selectedWorkflow?.id ?? selectedWorkflowId;
    if (keyboardRegion === 'workflowGraph' && workflowId && workflows.has(workflowId)) {
      const element = document.querySelector<HTMLElement>(`[data-testid="workflow-node-${workflowId}"]`);
      const point = nodeCenter(element);
      setContextMenu(null);
      setWorkflowContextMenu({ x: point.x, y: point.y, workflowId });
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

      // An open context menu owns navigation/activation keys so the graph
      // shortcuts below don't double-fire while the menu has focus.
      if (
        (contextMenu || workflowContextMenu) &&
        (event.key === 'ArrowUp' ||
          event.key === 'ArrowDown' ||
          event.key === 'Enter' ||
          event.key === ' ')
      ) {
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
        }
        return;
      }

      if (keyboardRegion === 'workflowGraph' || keyboardRegion === 'taskGraph') {
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
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          setInspectorCollapsed(false);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          setInspectorCollapsed(true);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          document.querySelector<HTMLElement>('[data-keyboard-region="inspector"] button, [data-keyboard-region="inspector"] select, [data-keyboard-region="inspector"] input')?.focus();
        }
        return;
      }

      if (keyboardRegion === 'bottomBar') {
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setTerminalCollapsed(false);
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setTerminalCollapsed(true);
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
  }, []);

  const openTerminalForTaskId = useCallback(async (taskId: string) => {
    const task = tasks.get(taskId);
    if (task && isExperimentSpawnPivotTask(task)) {
      window.alert(EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE);
      return;
    }
    setTerminalCollapsed(false);
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
  }, []);

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
      refreshTasks();
    } catch (err) {
      console.error('Delete Workflow failed:', err);
    }
  }, [refreshTasks, selectedWorkflowId]);

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
      refreshTasks();
    } catch (err) {
      console.error('Fix failed:', err);
    }
  }, [tasks, refreshTasks]);

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

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    setWorkflowContextMenu(null);
  }, []);

  const handleRefresh = useCallback(() => {
    refreshTasks(true);
    window.invoker?.checkPrStatuses?.();
  }, [refreshTasks]);

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
        refreshTasks();
      } catch (err) {
        console.error('Failed to load plan:', err);
      }
    },
    [invoker, refreshTasks],
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
        refreshTasks();
      } catch (err) {
        console.error('Failed to set merge branch:', err);
      }
    },
    [invoker, refreshTasks],
  );

  // ── Modal triggers ────────────────────────────────────────
  const openInputModal = useCallback((task: TaskState) => {
    setModal({ type: 'input', task });
  }, []);

  const openApprovalModal = useCallback((task: TaskState) => {
    console.log(`[openApprovalModal] taskId=${task.id} agentSessionId=${task.execution.agentSessionId} pendingFixError=${!!task.execution.pendingFixError}`);
    setModal({ type: 'approval', task, action: 'approve' });
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

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-gray-100" onClick={closeContextMenu}>
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
                    tasks={tasks}
                    workflows={workflows}
                    selectedWorkflowId={selectedWorkflow?.id ?? null}
                    centerWorkflowId={centerWorkflowId}
                    statusFilters={statusFilters}
                    onSelectWorkflow={handleWorkflowClick}
                    onWorkflowContextMenu={handleWorkflowContextMenu}
                  />
                  {selectedWorkflow && miniDagTasks.size > 0 && (
                    <FloatingGraphPanel
                      key={selectedWorkflow.id}
                      testId="selected-workflow-mini-dag"
                      dragHandleTestId="selected-workflow-mini-dag-drag-handle"
                      title={`${selectedWorkflow.name} task DAG`}
                      boundsRef={graphSurfaceRef}
                      contentClassName="h-[250px]"
                    >
                      <div
                        data-keyboard-region="taskGraph"
                        tabIndex={0}
                        data-keyboard-active={keyboardRegion === 'taskGraph' ? 'true' : 'false'}
                        className={`h-full outline-none ${keyboardRegion === 'taskGraph' ? 'ring-2 ring-inset ring-blue-300/60' : ''}`}
                      >
                        <TaskDAG
                          tasks={miniDagTasks}
                          workflows={workflows}
                          selectedTaskId={selectedTaskId}
                          centerTaskId={centerTaskId}
                          onTaskClick={handleTaskClick}
                          onTaskDoubleClick={handleTaskDoubleClick}
                          onTaskContextMenu={handleTaskContextMenu}
                          statusFilters={new Set()}
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
                <StatusBar
                  tasks={tasks}
                  activeFilters={statusFilters}
                  keyboardActiveKey={keyboardRegion === 'bottomBar' ? visibleStatusKeys[bottomStatusIndex] ?? null : null}
                  onStatusClick={(filterKey, event) => handleStatusClick(filterKey as WorkflowStatus, event)}
                />
                <TerminalDrawer
                  collapsed={terminalCollapsed}
                  onToggle={() => setTerminalCollapsed((prev) => !prev)}
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
              workflow={selectedWorkflow}
              task={selectedTask}
              workflowTasks={miniDagTasks}
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
              onSetMergeBranch={handleSetMergeBranch}
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
          onFix={handleFix}
          onCancel={handleCancelTask}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
