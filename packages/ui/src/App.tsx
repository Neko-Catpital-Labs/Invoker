/**
 * App — Main layout for Invoker UI.
 *
 * Layout:
 * - Top: Persistent TopBar (file loader, start/stop/clear)
 * - Left (60%): DAG visualization
 * - Right (40%): Task panel
 * - Bottom: Status bar
 * - Modals overlay when needed
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import yaml from 'js-yaml';
import type { TaskState, TaskReplacementDef } from './types.js';
import { useTasks } from './hooks/useTasks.js';
import { useInvoker } from './hooks/useInvoker.js';
import { TaskDAG } from './components/TaskDAG.js';
import { TaskPanel } from './components/TaskPanel.js';
import { StatusBar } from './components/StatusBar.js';
import { TopBar } from './components/TopBar.js';
import { HistoryView } from './components/HistoryView.js';
import { TimelineView } from './components/TimelineView.js';
import { ApprovalModal } from './components/ApprovalModal.js';
import { InputModal } from './components/InputModal.js';
import { ExperimentModal } from './components/ExperimentModal.js';
import { ContextMenu } from './components/ContextMenu.js';
import { QueueView } from './components/QueueView.js';
import { ReplaceTaskModal } from './components/ReplaceTaskModal.js';
import {
  isExperimentSpawnPivotTask,
  EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE,
} from './isExperimentSpawnPivot.js';

type ModalState =
  | { type: 'none' }
  | { type: 'input'; task: TaskState }
  | { type: 'approval'; task: TaskState; action: 'approve' | 'reject' }
  | { type: 'experiment'; task: TaskState }
  | { type: 'replace'; task: TaskState };

export function App() {
  const { tasks, workflows, clearTasks, refreshTasks } = useTasks();
  const invoker = useInvoker();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>({ type: 'none' });
  const [hasLoadedPlan, setHasLoadedPlan] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [planName, setPlanName] = useState<string | null>(null);
  const [onFinish, setOnFinish] = useState<'none' | 'merge' | 'pull_request'>('merge');
  const [viewMode, setViewMode] = useState<'dag' | 'history' | 'timeline' | 'queue'>('dag');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; task: TaskState } | null>(null);
  const [remoteTargets, setRemoteTargets] = useState<string[]>([]);
  const [executionAgents, setExecutionAgents] = useState<string[]>([]);
  const [statusFilters, setStatusFilters] = useState<Set<string>>(new Set());

  useEffect(() => {
    window.invoker?.getRemoteTargets?.().then(setRemoteTargets).catch(() => {});
    window.invoker?.getExecutionAgents?.().then(setExecutionAgents).catch(() => {});
  }, []);

  const handleStatusClick = useCallback((filterKey: string) => {
    setStatusFilters(prev => {
      const next = new Set(prev);
      if (next.has(filterKey)) {
        next.delete(filterKey);
      } else {
        next.add(filterKey);
      }
      return next;
    });
  }, []);

  const handleStatusDoubleClick = useCallback((filterKey: string) => {
    setStatusFilters(prev => {
      if (prev.size === 1 && prev.has(filterKey)) {
        return new Set<string>();
      }
      return new Set([filterKey]);
    });
  }, []);

  const selectedTask = selectedTaskId ? tasks.get(selectedTaskId) ?? null : null;

  // ── DAG interaction ───────────────────────────────────────
  const handleTaskClick = useCallback((task: TaskState) => {
    setSelectedTaskId(task.id);
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
    setContextMenu({ x: event.clientX, y: event.clientY, task });
  }, []);

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

  const handleRebaseAndRetry = useCallback(async (taskId: string) => {
    setContextMenu(null);
    try {
      const result = await window.invoker?.rebaseAndRetry(taskId);
      if (result && !result.success) {
        console.error('Rebase failed for some branches:', result.errors);
      }
    } catch (err) {
      console.error('Rebase & Retry failed:', err);
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

  const handleDeleteWorkflow = useCallback(async (workflowId: string) => {
    setContextMenu(null);
    const confirmed = window.confirm(
      'Delete this workflow and all its tasks? This cannot be undone.',
    );
    if (!confirmed) return;
    try {
      await window.invoker?.deleteWorkflow(workflowId);
      setSelectedTaskId(null);
      refreshTasks();
    } catch (err) {
      console.error('Delete Workflow failed:', err);
    }
  }, [refreshTasks]);

  const handleFix = useCallback(async (taskId: string, agentName: string) => {
    setContextMenu(null);
    const task = tasks.get(taskId);
    if (task?.config.familiarType === 'docker') {
      const proceed = window.confirm(
        'Note: AI CLI tools have known freeze issues inside Docker containers. ' +
        'The automated fix will run in non-interactive pipe mode which is unaffected.\n\n' +
        'However, double-clicking to resume the session interactively may freeze.\n\n' +
        `Proceed with Fix with ${agentName}?`,
      );
      if (!proceed) return;
    }
    try {
      const hasMergeConflict = !!task?.execution.mergeConflict;
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
      `Cancel task "${taskId}" and all downstream dependents?`
    );
    if (!confirmed) return;
    try {
      await window.invoker?.cancelTask(taskId);
    } catch (err) {
      console.error('Failed to cancel task:', err);
    }
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleRefresh = useCallback(() => {
    refreshTasks();
    window.invoker?.checkPrStatuses?.();
  }, [refreshTasks]);

  // ── Plan loading ──────────────────────────────────────────
  const handleLoadPlan = useCallback(
    async (planText: string) => {
      if (!invoker) return;
      try {
        await invoker.loadPlan(planText);
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
      setModal({ type: 'none' });
      setStatusFilters(new Set());
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
      await invoker.deleteAllWorkflows();
      clearTasks();
      setHasLoadedPlan(false);
      setHasStarted(false);
      setPlanName(null);
      setSelectedTaskId(null);
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

  // ── Edit task executor type ───────────────────────────────
  const handleEditType = useCallback(
    async (taskId: string, familiarType: string, remoteTargetId?: string) => {
      if (!invoker) return;
      try {
        await invoker.editTaskType(taskId, familiarType, remoteTargetId);
      } catch (err) {
        console.error('Failed to edit task type:', err);
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

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-gray-100">
      {/* Top bar */}
      <TopBar
        planName={planName}
        hasLoadedPlan={hasLoadedPlan}
        hasStarted={hasStarted}
        allSettled={allSettled}
        onLoadFile={handleLoadPlan}
        onStart={handleStart}
        onStop={handleStop}
        onClear={handleClear}
        onDeleteDB={handleDeleteDB}
        onRefresh={handleRefresh}
        viewMode={viewMode}
        onToggleView={setViewMode}
      />

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: DAG visualization (60%) */}
        <div className="w-3/5 border-r border-gray-700">
          {viewMode === 'queue' ? (
            <div className="h-full">
              <QueueView
                tasks={tasks}
                onTaskClick={handleTaskClick}
                onCancel={handleCancelTask}
                selectedTaskId={selectedTaskId}
              />
            </div>
          ) : viewMode === 'history' ? (
            <div className="h-full">
              <HistoryView onTaskClick={handleTaskClick} selectedTaskId={selectedTaskId} />
            </div>
          ) : viewMode === 'timeline' ? (
            <div className="h-full">
              <TimelineView tasks={tasks} onTaskClick={handleTaskClick} selectedTaskId={selectedTaskId} />
            </div>
          ) : tasks.size === 0 ? (
            <div className="h-full flex items-center justify-center text-gray-500 text-sm">
              Load a plan to get started
            </div>
          ) : (
            <div className="h-full">
              <TaskDAG tasks={tasks} workflows={workflows} onTaskClick={handleTaskClick} onTaskDoubleClick={handleTaskDoubleClick} onTaskContextMenu={handleTaskContextMenu} statusFilters={statusFilters} />
            </div>
          )}
        </div>

        {/* Right: Task panel (40%) */}
        <div className="w-2/5 flex flex-col">
          <div className="flex-1 overflow-hidden bg-gray-800">
            <TaskPanel
              task={selectedTask}
              baseBranch={selectedTask?.config.workflowId ? workflows.get(selectedTask.config.workflowId)?.baseBranch : undefined}
              mergeMode={selectedTask?.config.workflowId ? workflows.get(selectedTask.config.workflowId)?.mergeMode : undefined}
              onFinish={selectedTask?.config.workflowId ? workflows.get(selectedTask.config.workflowId)?.onFinish : undefined}
              remoteTargets={remoteTargets}
              executionAgents={executionAgents}
              onProvideInput={openInputModal}
              onApprove={openApprovalModal}
              onReject={(task) => {
                setModal({ type: 'approval', task, action: 'reject' });
              }}
              onSelectExperiment={openExperimentModal}
              onEditCommand={handleEditCommand}
              onEditType={handleEditType}
              onEditAgent={handleEditAgent}
              onSetMergeBranch={invoker?.setMergeBranch}
              onSetMergeMode={invoker?.setMergeMode}
            />
          </div>
        </div>
      </div>

      {/* Status bar */}
      <StatusBar tasks={tasks} onSystemLog={() => setSelectedTaskId('__system__')} activeFilters={statusFilters} onStatusClick={handleStatusClick} onStatusDoubleClick={handleStatusDoubleClick} />

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

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          task={contextMenu.task}
          onRestart={handleRestartTask}
          onReplace={handleReplaceTask}
          onOpenTerminal={handleOpenTerminal}
          onRebaseAndRetry={handleRebaseAndRetry}
          onRetryWorkflow={handleRetryWorkflow}
          onRecreateWorkflow={handleRecreateWorkflow}
          onDeleteWorkflow={handleDeleteWorkflow}
          onFix={handleFix}
          onCancel={handleCancelTask}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
