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
import type { ActionGraphNode } from '@invoker/contracts';
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

type SidebarSurface = 'home' | 'workflows' | 'attention';

interface WorkflowMutationFailedEvent {
  intentId: number;
  workflowId: string;
  channel: string;
  taskId?: string;
  headlessCommand?: string;
  message: string;
  failedAt: string;
}

interface WorkflowMutationFailedEvents {
  onWorkflowMutationFailed?: (cb: (event: WorkflowMutationFailedEvent) => void) => () => void;
}

interface MutationFailureAttentionEntry {
  task: TaskState;
  workflow: WorkflowMeta | null;
  failure: WorkflowMutationFailedEvent;
}

interface WorkflowContextMenuProps {
  x: number;
  y: number;
  workflowId: string;
  onOpenWorkflow: (workflowId: string) => void;
  onOpenPr: (workflowId: string) => void;
  onRetryWorkflow: (workflowId: string) => void;
  onRecreateWithRebase: (workflowId: string) => void;
  onRecreateWorkflow: (workflowId: string) => void;
  onCancelWorkflow: (workflowId: string) => void;
  onDeleteWorkflow: (workflowId: string) => void;
  onCopyWorkflowId: (workflowId: string) => void;
  onClose: () => void;
}

function WorkflowContextMenu({
  x,
  y,
  workflowId,
  onOpenWorkflow,
  onOpenPr,
  onRetryWorkflow,
  onRecreateWithRebase,
  onRecreateWorkflow,
  onCancelWorkflow,
  onDeleteWorkflow,
  onCopyWorkflowId,
  onClose,
}: WorkflowContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [showMore, setShowMore] = useState(false);

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

  const runAction = (action: (workflowId: string) => void) => {
    action(workflowId);
    onClose();
  };

  const buttonClass = 'w-full px-3 py-1.5 text-left text-sm text-gray-100 hover:bg-gray-700';
  const dangerButtonClass = 'w-full px-3 py-1.5 text-left text-sm text-red-300 hover:bg-gray-700';

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 min-w-[200px] rounded-lg border border-gray-600 bg-gray-800 py-1 shadow-xl"
      style={{ left: position.left, top: position.top }}
      tabIndex={-1}
      onClick={(event) => event.stopPropagation()}
    >
      <button role="menuitem" onClick={() => runAction(onOpenWorkflow)} className={buttonClass}>
        Open Workflow
      </button>
      <button role="menuitem" onClick={() => runAction(onOpenPr)} className={buttonClass}>
        Open PR
      </button>
      <button role="menuitem" onClick={() => runAction(onRetryWorkflow)} className={buttonClass}>
        Retry Workflow
      </button>
      <button role="menuitem" onClick={() => runAction(onCopyWorkflowId)} className={buttonClass}>
        Copy Workflow ID
      </button>
      {!showMore ? (
        <div>
          <div className="my-1 border-t border-gray-600" />
          <button
            role="menuitem"
            className="w-full px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-gray-700"
            onClick={() => setShowMore(true)}
          >
            More
          </button>
        </div>
      ) : (
        <div>
          <div className="my-1 border-t border-gray-600" />
          <button role="menuitem" onClick={() => runAction(onRecreateWithRebase)} className={dangerButtonClass}>
            Recreate with Rebase
          </button>
          <button role="menuitem" onClick={() => runAction(onRecreateWorkflow)} className={dangerButtonClass}>
            Recreate Workflow
          </button>
          <button role="menuitem" onClick={() => runAction(onCancelWorkflow)} className={dangerButtonClass}>
            Cancel Workflow
          </button>
          <button role="menuitem" onClick={() => runAction(onDeleteWorkflow)} className={dangerButtonClass}>
            Delete Workflow
          </button>
        </div>
      )}
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

function workflowMutationFailureTitle(failure: WorkflowMutationFailedEvent): string {
  if (failure.channel === 'invoker:approve') return 'Approve failed';
  if (failure.channel === 'invoker:reject') return 'Reject failed';
  if (failure.headlessCommand === 'fix') return 'Fix failed';
  return `Mutation failed (${failure.channel})`;
}

function displayTaskId(taskId: string): string {
  const slash = taskId.lastIndexOf('/');
  return slash >= 0 ? taskId.slice(slash + 1) : taskId;
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
  const [workflowContextMenu, setWorkflowContextMenu] = useState<{ x: number; y: number; workflowId: string } | null>(null);
  const [sidebarSurface, setSidebarSurface] = useState<SidebarSurface>('home');
  const [mutationFailuresByTaskId, setMutationFailuresByTaskId] = useState<Map<string, WorkflowMutationFailedEvent>>(new Map());
  const uiPerfThrottleRef = useRef<Record<string, number>>({});

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
    const invokerWithMutationEvents = window.invoker as typeof window.invoker & WorkflowMutationFailedEvents;
    return invokerWithMutationEvents.onWorkflowMutationFailed?.((event) => {
      if (event.taskId) {
        const failedTaskId = event.taskId;
        setMutationFailuresByTaskId((prev) => new Map(prev).set(failedTaskId, event));
        return;
      }

      setViewMode('dag');
      setSidebarSurface('workflows');
      setSelectedTaskId(null);
      setWorkflowSelectionDismissed(false);
      if (event.workflowId) {
        setSelectedWorkflowId(event.workflowId);
      }
    });
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
  const attentionEntries = useMemo<MutationFailureAttentionEntry[]>(() => {
    const entries: MutationFailureAttentionEntry[] = [];
    for (const [taskId, failure] of mutationFailuresByTaskId) {
      const task = tasks.get(taskId);
      if (!task) continue;
      entries.push({
        task,
        workflow: task.config.workflowId ? workflows.get(task.config.workflowId) ?? null : null,
        failure,
      });
    }
    return entries;
  }, [mutationFailuresByTaskId, tasks, workflows]);
  const workflowEntries = useMemo(
    () => [...workflows.values()].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
    [workflows],
  );
  const selectedMutationFailure = selectedTaskId ? mutationFailuresByTaskId.get(selectedTaskId) ?? null : null;

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

  const handleTaskDoubleClick = useCallback(async (task: TaskState) => {
    setSelectedTaskId(task.id);
    if (isExperimentSpawnPivotTask(task)) {
      window.alert(EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE);
      return;
    }
    const result = await window.invoker?.openTerminal(task.id);
    if (result && !result.opened) {
      window.alert(result.reason ?? 'Cannot open terminal for this task.');
    }
  }, []);

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

  const selectAttentionTask = useCallback((task: TaskState) => {
    setViewMode('dag');
    setSelectedTaskId(task.id);
    setWorkflowSelectionDismissed(false);
    if (task.config.workflowId) {
      setSelectedWorkflowId(task.config.workflowId);
    }
    setWorkflowContextMenu(null);
    setContextMenu(null);
  }, []);

  const handleOpenWorkflowsSurface = useCallback(() => {
    setViewMode('dag');
    setSidebarSurface('workflows');
    setWorkflowSelectionDismissed(false);
    setSelectedTaskId(null);
  }, []);

  const handleOpenAttentionSurface = useCallback(() => {
    setViewMode('dag');
    setSidebarSurface('attention');
    const selectedIsAttentionEntry = attentionEntries.some((entry) => entry.task.id === selectedTaskId);
    if (!selectedIsAttentionEntry && attentionEntries[0]) {
      selectAttentionTask(attentionEntries[0].task);
    }
  }, [attentionEntries, selectAttentionTask, selectedTaskId]);

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
      const task = tasks.get(taskId);
      if (task && isExperimentSpawnPivotTask(task)) {
        window.alert(EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE);
        return;
      }
      void window.invoker?.openTerminal(taskId);
    },
    [tasks],
  );

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

  const handleRecreateWithRebase = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.recreateWithRebase(workflowId);
      if (result && !result.success) {
        console.error('Recreate with Rebase failed for some branches:', result.errors);
      }
    } catch (err) {
      console.error('Recreate with Rebase failed:', err);
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
      setSidebarSurface('home');
      setMutationFailuresByTaskId(new Map());
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
      setSidebarSurface('home');
      setMutationFailuresByTaskId(new Map());
      setModal({ type: 'none' });
    } catch (err) {
      console.error('Failed to delete workflows:', err);
    }
  }, [invoker, clearTasks]);

  // True when all tasks have reached a terminal state.
  const allSettled = useMemo(() => {
    if (tasks.size === 0) return false;
    for (const task of tasks.values()) {
      if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'blocked') {
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
                setSidebarSurface('home');
              }}
              aria-current={sidebarSurface === 'home' && viewMode === 'dag' ? 'page' : undefined}
              className={`w-full rounded px-2 py-1.5 text-left text-xs ${sidebarSurface === 'home' && viewMode === 'dag' ? 'bg-gray-800 text-white' : 'text-gray-300 hover:bg-gray-800/70'}`}
            >
              <span
                data-testid="sidebar-home"
                aria-current={sidebarSurface === 'home' && viewMode === 'dag' ? 'page' : undefined}
                className="contents"
              >
                Home
              </span>
            </button>
            <button
              data-testid="sidebar-workflows"
              onClick={handleOpenWorkflowsSurface}
              aria-current={sidebarSurface === 'workflows' ? 'page' : undefined}
              className={`w-full rounded px-2 py-1.5 text-left text-xs ${sidebarSurface === 'workflows' ? 'bg-gray-800 text-white' : 'text-gray-300 hover:bg-gray-800/70'}`}
            >
              Workflows
            </button>
            {attentionEntries.length > 0 && (
              <button
                data-testid="sidebar-attention"
                onClick={handleOpenAttentionSurface}
                aria-current={sidebarSurface === 'attention' ? 'page' : undefined}
                className={`w-full rounded px-2 py-1.5 text-left text-xs ${sidebarSurface === 'attention' ? 'bg-amber-900/70 text-amber-100' : 'text-amber-200 hover:bg-amber-950/50'}`}
              >
                <span data-testid="rail-attention" className="contents">Needs Attention</span>
              </button>
            )}
            <button
              data-testid="rail-timeline"
              onClick={() => {
                setViewMode('timeline');
                setSidebarSurface('home');
              }}
              className={`w-full rounded px-2 py-1.5 text-left text-xs ${sidebarSurface === 'home' && viewMode === 'timeline' ? 'bg-gray-800 text-white' : 'text-gray-300 hover:bg-gray-800/70'}`}
            >
              Timeline
            </button>
            <button
              data-testid="rail-history"
              onClick={() => {
                setViewMode('history');
                setSidebarSurface('home');
              }}
              className={`w-full rounded px-2 py-1.5 text-left text-xs ${sidebarSurface === 'home' && viewMode === 'history' ? 'bg-gray-800 text-white' : 'text-gray-300 hover:bg-gray-800/70'}`}
            >
              History
            </button>
            <button
              data-testid="rail-action-graph"
              onClick={() => {
                setViewMode('actionGraph');
                setSidebarSurface('home');
                setWorkflowSelectionDismissed(true);
                setSelectedTaskId(null);
              }}
              className={`w-full rounded px-2 py-1.5 text-left text-xs ${sidebarSurface === 'home' && viewMode === 'actionGraph' ? 'bg-gray-800 text-white' : 'text-gray-300 hover:bg-gray-800/70'}`}
            >
              Action Graph
            </button>
            <button
              data-testid="rail-queue"
              onClick={() => {
                setViewMode('queue');
                setSidebarSurface('home');
              }}
              className={`w-full rounded px-2 py-1.5 text-left text-xs ${sidebarSurface === 'home' && viewMode === 'queue' ? 'bg-gray-800 text-white' : 'text-gray-300 hover:bg-gray-800/70'}`}
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

        {sidebarSurface !== 'home' && (
          <aside
            data-testid="browser-rail"
            className="w-72 shrink-0 border-r border-gray-800 bg-gray-950/80 flex flex-col"
          >
            <div className="border-b border-gray-800 px-3 py-3">
              <h2 className="text-sm font-semibold text-gray-100">
                {sidebarSurface === 'workflows' ? 'Workflows' : 'Needs Attention'}
              </h2>
              <p className="mt-1 text-xs text-gray-400">
                {sidebarSurface === 'workflows'
                  ? `${workflowEntries.length} workflow${workflowEntries.length === 1 ? '' : 's'}`
                  : `${attentionEntries.length} mutation failure${attentionEntries.length === 1 ? '' : 's'}`}
              </p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {sidebarSurface === 'workflows' ? (
                workflowEntries.length > 0 ? (
                  <div className="space-y-1">
                    {workflowEntries.map((workflow) => (
                      <button
                        key={workflow.id}
                        type="button"
                        onClick={() => handleWorkflowClick(workflow.id)}
                        className={`w-full rounded border px-3 py-2 text-left text-xs ${
                          selectedWorkflow?.id === workflow.id && !selectedTaskId
                            ? 'border-blue-500/60 bg-blue-950/40 text-blue-100'
                            : 'border-gray-800 bg-gray-900/70 text-gray-200 hover:border-gray-700 hover:bg-gray-900'
                        }`}
                      >
                        <div className="truncate font-medium">{workflow.name || workflow.id}</div>
                        <div className="mt-1 truncate text-[11px] text-gray-400">{workflow.status}</div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="px-2 py-8 text-center text-xs text-gray-500">No workflows yet</div>
                )
              ) : attentionEntries.length > 0 ? (
                <div className="space-y-1">
                  {attentionEntries.map((entry) => (
                    <button
                      key={entry.task.id}
                      type="button"
                      onClick={() => selectAttentionTask(entry.task)}
                      className={`w-full rounded border px-3 py-2 text-left text-xs ${
                        selectedTaskId === entry.task.id
                          ? 'border-amber-500/60 bg-amber-950/40 text-amber-100'
                          : 'border-gray-800 bg-gray-900/70 text-gray-200 hover:border-gray-700 hover:bg-gray-900'
                      }`}
                    >
                      <div className="truncate font-medium">{entry.task.description || displayTaskId(entry.task.id)}</div>
                      <div className="mt-1 truncate text-[11px] text-gray-400">
                        {entry.workflow?.name ?? entry.failure.workflowId}
                      </div>
                      <div className="mt-1 truncate text-[11px] text-amber-300">
                        {workflowMutationFailureTitle(entry.failure)}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="px-2 py-8 text-center text-xs text-gray-500">All clear</div>
              )}
            </div>
          </aside>
        )}

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 flex flex-col overflow-hidden">
            <div
              ref={graphSurfaceRef}
              data-testid="workflow-graph-surface"
              className="flex-1 relative overflow-hidden border-r border-gray-800 bg-gray-900"
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
                      <TaskDAG
                        tasks={miniDagTasks}
                        workflows={workflows}
                        selectedTaskId={selectedTaskId}
                        onTaskClick={handleTaskClick}
                        onTaskDoubleClick={handleTaskDoubleClick}
                        onTaskContextMenu={handleTaskContextMenu}
                        statusFilters={new Set()}
                      />
                    </FloatingGraphPanel>
                  )}
                </>
              )}
            </div>

            {viewMode === 'dag' && (
              <>
                <StatusBar
                  tasks={tasks}
                  activeFilters={statusFilters}
                  onStatusClick={(filterKey, event) => handleStatusClick(filterKey as WorkflowStatus, event)}
                />
                <TerminalDrawer
                  collapsed={terminalCollapsed}
                  onToggle={() => setTerminalCollapsed((prev) => !prev)}
                />
              </>
            )}
          </div>

          <div className={`${inspectorCollapsed ? 'w-16' : 'w-96'} transition-all duration-150 flex flex-col`}>
            <div className="min-h-0 flex-1">
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
            {!inspectorCollapsed && selectedTask && selectedMutationFailure && (
              <section
                data-testid="task-mutation-failure-detail"
                className="border-l border-t border-amber-800 bg-amber-950/50 p-3 text-xs text-amber-100"
              >
                <h3 className="font-semibold text-amber-50">
                  {workflowMutationFailureTitle(selectedMutationFailure)}
                </h3>
                <div className="mt-2 space-y-1 text-amber-100/90">
                  <div>Channel: {selectedMutationFailure.channel}</div>
                  {selectedMutationFailure.headlessCommand && (
                    <div>Command: {selectedMutationFailure.headlessCommand}</div>
                  )}
                  <div>Intent: {selectedMutationFailure.intentId}</div>
                </div>
                <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded border border-amber-800/70 bg-gray-950/70 p-2 font-mono text-[11px] leading-relaxed text-amber-100">
                  {selectedMutationFailure.message}
                </pre>
              </section>
            )}
          </div>
        </div>
      </div>

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
          onRecreateWithRebase={(workflowId) => void handleRecreateWithRebase(workflowId)}
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
