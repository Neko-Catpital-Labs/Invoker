/**
 * Preload Script — Exposes a safe IPC bridge to the renderer via contextBridge.
 *
 * Runs in a sandboxed context with access to ipcRenderer.
 * The renderer accesses this API through `window.invoker`.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { TaskStateChanges } from '@invoker/workflow-core';
import type { InvokerAPI } from './types.js';

const api: InvokerAPI = {
  getClaudeSession: (sessionId) => ipcRenderer.invoke('invoker:get-claude-session', sessionId),
  getAgentSession: (sessionId, agentName) => ipcRenderer.invoke('invoker:get-agent-session', sessionId, agentName),
  loadPlan: (plan) => ipcRenderer.invoke('invoker:load-plan', plan),
  start: () => ipcRenderer.invoke('invoker:start'),
  stop: () => ipcRenderer.invoke('invoker:stop'),
  clear: () => ipcRenderer.invoke('invoker:clear'),
  getTasks: (forceRefresh?: boolean) => ipcRenderer.invoke('invoker:get-tasks', forceRefresh),
  getStatus: () => ipcRenderer.invoke('invoker:get-status'),
  provideInput: (taskId, input) =>
    ipcRenderer.invoke('invoker:provide-input', taskId, input),
  approve: (taskId) => ipcRenderer.invoke('invoker:approve', taskId),
  reject: (taskId, reason) =>
    ipcRenderer.invoke('invoker:reject', taskId, reason),
  selectExperiment: (taskId, experimentId) =>
    ipcRenderer.invoke('invoker:select-experiment', taskId, experimentId),
  restartTask: (taskId) =>
    ipcRenderer.invoke('invoker:restart-task', taskId),
  editTaskCommand: (taskId, newCommand) =>
    ipcRenderer.invoke('invoker:edit-task-command', taskId, newCommand),
  editTaskType: (taskId, executorType, remoteTargetId?) =>
    ipcRenderer.invoke('invoker:edit-task-type', taskId, executorType, remoteTargetId),
  editTaskAgent: (taskId, agentName) =>
    ipcRenderer.invoke('invoker:edit-task-agent', taskId, agentName),
  setTaskExternalGatePolicies: (taskId, updates) =>
    ipcRenderer.invoke('invoker:set-task-external-gate-policies', taskId, updates),
  getRemoteTargets: () => ipcRenderer.invoke('invoker:get-remote-targets'),
  getExecutionAgents: () => ipcRenderer.invoke('invoker:get-execution-agents'),
  replaceTask: (taskId, replacementTasks) =>
    ipcRenderer.invoke('invoker:replace-task', taskId, replacementTasks),
  onTaskDelta: (cb) => {
    const handler = (_event: Electron.IpcRendererEvent, delta: unknown) => cb(delta as any);
    ipcRenderer.on('invoker:task-delta', handler);
    return () => ipcRenderer.removeListener('invoker:task-delta', handler);
  },
  onTaskOutput: (cb) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => cb(data as any);
    ipcRenderer.on('invoker:task-output', handler);
    return () => ipcRenderer.removeListener('invoker:task-output', handler);
  },
  onActivityLog: (cb) => {
    const handler = (_event: Electron.IpcRendererEvent, entries: unknown) => cb(entries as any);
    ipcRenderer.on('invoker:activity-log', handler);
    return () => ipcRenderer.removeListener('invoker:activity-log', handler);
  },
  getActivityLogs: () => ipcRenderer.invoke('invoker:get-activity-logs'),
  getEvents: (taskId: string) => ipcRenderer.invoke('invoker:get-events', taskId),
  getTaskOutput: (taskId: string) => ipcRenderer.invoke('invoker:get-task-output', taskId),

  // External terminal launcher
  openTerminal: (taskId: string) =>
    ipcRenderer.invoke('invoker:open-terminal', taskId),

  // Workflow management
  resumeWorkflow: () => ipcRenderer.invoke('invoker:resume-workflow'),
  listWorkflows: () => ipcRenderer.invoke('invoker:list-workflows'),
  loadWorkflow: (workflowId: string) =>
    ipcRenderer.invoke('invoker:load-workflow', workflowId),
  deleteAllWorkflows: () => ipcRenderer.invoke('invoker:delete-all-workflows'),
  deleteWorkflow: (workflowId: string) =>
    ipcRenderer.invoke('invoker:delete-workflow', workflowId),
  getAllCompletedTasks: () => ipcRenderer.invoke('invoker:get-all-completed-tasks'),
  cleanupWorktrees: () => ipcRenderer.invoke('invoker:cleanup-worktrees'),
  onWorkflowsChanged: (cb: (workflows: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, workflows: unknown[]) => cb(workflows);
    ipcRenderer.on('invoker:workflows-changed', handler);
    return () => ipcRenderer.removeListener('invoker:workflows-changed', handler);
  },
  recreateWorkflow: (workflowId: string) =>
    ipcRenderer.invoke('invoker:recreate-workflow', workflowId),
  recreateTask: (taskId: string) =>
    ipcRenderer.invoke('invoker:recreate-task', taskId),
  retryWorkflow: (workflowId: string) =>
    ipcRenderer.invoke('invoker:retry-workflow', workflowId),
  rebaseAndRetry: (mergeTaskId: string) =>
    ipcRenderer.invoke('invoker:rebase-and-retry', mergeTaskId),
  setMergeBranch: (workflowId: string, baseBranch: string) =>
    ipcRenderer.invoke('invoker:set-merge-branch', workflowId, baseBranch),
  approveMerge: (workflowId: string) =>
    ipcRenderer.invoke('invoker:approve-merge', workflowId),
  resolveConflict: (taskId: string, agentName?: string) =>
    ipcRenderer.invoke('invoker:resolve-conflict', taskId, agentName),
  fixWithAgent: (taskId: string, agentName?: string) =>
    ipcRenderer.invoke('invoker:fix-with-agent', taskId, agentName),
  setMergeMode: (workflowId: string, mergeMode: string) =>
    ipcRenderer.invoke('invoker:set-merge-mode', workflowId, mergeMode),
  checkPrStatuses: () => ipcRenderer.invoke('invoker:check-pr-statuses'),
  checkPrStatus: () => ipcRenderer.invoke('invoker:check-pr-status'),
  cancelTask: (taskId: string) =>
    ipcRenderer.invoke('invoker:cancel-task', taskId),
  cancelWorkflow: (workflowId: string) =>
    ipcRenderer.invoke('invoker:cancel-workflow', workflowId),
  getQueueStatus: () => ipcRenderer.invoke('invoker:get-queue-status'),
  reportUiPerf: (metric: string, data?: Record<string, unknown>) =>
    ipcRenderer.invoke('invoker:report-ui-perf', metric, data),
  getUiPerfStats: () => ipcRenderer.invoke('invoker:get-ui-perf-stats'),
};

if (process.env.NODE_ENV === 'test') {
  api.injectTaskStates = (updates: Array<{ taskId: string; changes: TaskStateChanges }>) =>
    ipcRenderer.invoke('invoker:inject-task-states', updates);
}

contextBridge.exposeInMainWorld('invoker', api);
