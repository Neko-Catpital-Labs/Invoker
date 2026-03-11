/**
 * App — Main layout for Invoker UI.
 *
 * Layout:
 * - Top: Persistent TopBar (file loader, start/stop/clear)
 * - Left (60%): DAG visualization
 * - Right (40%): Task panel + terminal
 * - Bottom: Status bar
 * - Modals overlay when needed
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import yaml from 'js-yaml';
import type { TaskState, PlanDefinition } from './types.js';
import { useTasks } from './hooks/useTasks.js';
import { useInvoker } from './hooks/useInvoker.js';
import { TaskDAG } from './components/TaskDAG.js';
import { TaskPanel } from './components/TaskPanel.js';
import { Terminal } from './components/Terminal.js';
import { StatusBar } from './components/StatusBar.js';
import { TopBar } from './components/TopBar.js';
import { HistoryView } from './components/HistoryView.js';
import { TimelineView } from './components/TimelineView.js';
import { ApprovalModal } from './components/ApprovalModal.js';
import { InputModal } from './components/InputModal.js';
import { ExperimentModal } from './components/ExperimentModal.js';
import { ContextMenu } from './components/ContextMenu.js';

type ModalState =
  | { type: 'none' }
  | { type: 'input'; task: TaskState }
  | { type: 'approval'; task: TaskState }
  | { type: 'experiment'; task: TaskState };

export function App() {
  const { tasks, clearTasks, refreshTasks } = useTasks();
  const invoker = useInvoker();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>({ type: 'none' });
  const [hasLoadedPlan, setHasLoadedPlan] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [planName, setPlanName] = useState<string | null>(null);
  const [onFinish, setOnFinish] = useState<'none' | 'merge' | 'pull_request'>('merge');
  const [viewMode, setViewMode] = useState<'dag' | 'history' | 'timeline'>('dag');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; task: TaskState } | null>(null);
  const [canResume, setCanResume] = useState(false);

  const selectedTask = selectedTaskId ? tasks.get(selectedTaskId) ?? null : null;

  // ── Check for resumable workflows on mount ─────────────────
  useEffect(() => {
    window.invoker?.listWorkflows().then((workflows) => {
      setCanResume(workflows.length > 0);
    }).catch(() => {});
  }, []);

  // ── Collapsible terminal ───────────────────────────────────
  const [terminalExpanded, setTerminalExpanded] = useState(false);

  // Auto-expand when a task is selected, auto-collapse when deselected
  useEffect(() => {
    setTerminalExpanded(selectedTaskId !== null);
  }, [selectedTaskId]);

  const toggleTerminal = useCallback(() => {
    setTerminalExpanded((prev) => !prev);
  }, []);

  // ── Keyboard shortcut: Ctrl+` to toggle terminal ───────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        toggleTerminal();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [toggleTerminal]);

  // ── DAG interaction ───────────────────────────────────────
  const handleTaskClick = useCallback((task: TaskState) => {
    setSelectedTaskId(task.id);
  }, []);

  const handleTaskDoubleClick = useCallback(async (task: TaskState) => {
    setSelectedTaskId(task.id);
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

  const handleOpenTerminal = useCallback((taskId: string) => {
    setContextMenu(null);
    window.invoker?.openTerminal(taskId);
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // ── Plan loading ──────────────────────────────────────────
  const handleLoadPlan = useCallback(
    async (planText: string) => {
      if (!invoker) return;
      try {
        const plan = yaml.load(planText) as PlanDefinition;
        await invoker.loadPlan(plan);
        setHasLoadedPlan(true);
        setPlanName(plan.name ?? 'Untitled Plan');
        setOnFinish(plan.onFinish ?? 'merge');
      } catch (err) {
        console.error('Failed to load plan:', err);
      }
    },
    [invoker],
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

  const handleResume = useCallback(async () => {
    if (!invoker) return;
    try {
      const result = await invoker.resumeWorkflow();
      if (!result) {
        console.warn('No workflow to resume');
        return;
      }
      setPlanName(result.workflow.name ?? 'Resumed Workflow');
      setHasLoadedPlan(true);
      setHasStarted(true);
      setCanResume(false);
    } catch (err) {
      console.error('Failed to resume workflow:', err);
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

  const handleCleanupWorktrees = useCallback(async () => {
    if (!invoker) return;
    try {
      const result = await invoker.cleanupWorktrees();
      if (result.removed.length > 0) {
        window.alert(`Removed ${result.removed.length} orphan worktree(s): ${result.removed.join(', ')}`);
      } else {
        window.alert('No orphan worktrees found.');
      }
      if (result.errors.length > 0) {
        console.warn('Worktree cleanup errors:', result.errors);
      }
    } catch (err) {
      console.error('Failed to cleanup worktrees:', err);
    }
  }, [invoker]);

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
    async (taskId: string, experimentId: string) => {
      if (!invoker) return;
      await invoker.selectExperiment(taskId, experimentId);
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
    async (taskId: string, familiarType: string) => {
      if (!invoker) return;
      try {
        await invoker.editTaskType(taskId, familiarType);
      } catch (err) {
        console.error('Failed to edit task type:', err);
      }
    },
    [invoker],
  );

  // ── Modal triggers ────────────────────────────────────────
  const openInputModal = useCallback((task: TaskState) => {
    setModal({ type: 'input', task });
  }, []);

  const openApprovalModal = useCallback((task: TaskState) => {
    setModal({ type: 'approval', task });
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
        canResume={canResume}
        onLoadFile={handleLoadPlan}
        onStart={handleStart}
        onStop={handleStop}
        onResume={handleResume}
        onClear={handleClear}
        onDeleteDB={handleDeleteDB}
        onRefresh={refreshTasks}
        onCleanupWorktrees={handleCleanupWorktrees}
        viewMode={viewMode}
        onToggleView={setViewMode}
      />

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: DAG visualization (60%) */}
        <div className="w-3/5 border-r border-gray-700">
          {viewMode === 'history' ? (
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
              <TaskDAG tasks={tasks} onFinish={onFinish} onTaskClick={handleTaskClick} onTaskDoubleClick={handleTaskDoubleClick} onTaskContextMenu={handleTaskContextMenu} />
            </div>
          )}
        </div>

        {/* Right: Task panel + terminal (40%) */}
        <div className="w-2/5 flex flex-col">
          {/* Task panel — grows to fill when terminal is collapsed */}
          <div
            className="border-b border-gray-700 overflow-hidden bg-gray-800 transition-all duration-300 ease-in-out"
            style={{ flex: terminalExpanded ? '1 1 0%' : '1 1 100%' }}
          >
            <TaskPanel
              task={selectedTask}
              onProvideInput={openInputModal}
              onApprove={openApprovalModal}
              onReject={(task) => {
                setModal({ type: 'approval', task });
              }}
              onSelectExperiment={openExperimentModal}
              onEditCommand={handleEditCommand}
              onEditType={handleEditType}
            />
          </div>

          {/* Terminal header — always visible toggle bar */}
          <button
            onClick={toggleTerminal}
            className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 border-t border-gray-700 text-gray-400 hover:text-gray-200 hover:bg-gray-750 transition-colors duration-200 text-xs font-mono cursor-pointer select-none shrink-0"
          >
            {/* Chevron rotates based on state */}
            <svg
              className={`w-3 h-3 transition-transform duration-200 ${terminalExpanded ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
            </svg>

            {/* Terminal icon */}
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>

            <span>Terminal</span>
            {selectedTaskId && <span className="text-gray-500">— {selectedTaskId}</span>}

            {/* State badge + shortcut hint pushed to the right */}
            <span className="ml-auto flex items-center gap-2">
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${terminalExpanded ? 'bg-green-900/40 text-green-400' : 'bg-gray-700 text-gray-500'}`}>
                {terminalExpanded ? 'open' : 'closed'}
              </span>
              <kbd className="text-[10px] text-gray-600 bg-gray-700/50 px-1 py-0.5 rounded border border-gray-600/50">Ctrl+`</kbd>
            </span>
          </button>

          {/* Terminal body — collapsible */}
          <div
            className="overflow-hidden transition-all duration-300 ease-in-out"
            style={{ flex: terminalExpanded ? '1 1 0%' : '0 0 0px' }}
          >
            {terminalExpanded && <Terminal taskId={selectedTaskId} />}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <StatusBar tasks={tasks} onSystemLog={() => setSelectedTaskId('__system__')} />

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
        />
      )}

      {modal.type === 'experiment' && (
        <ExperimentModal
          task={modal.task}
          onSelect={handleSelectExperiment}
          onClose={closeModal}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          task={contextMenu.task}
          onRestart={handleRestartTask}
          onOpenTerminal={handleOpenTerminal}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
