/**
 * Preload Script — Exposes a safe IPC bridge to the renderer via contextBridge.
 *
 * Runs in a sandboxed context with access to ipcRenderer.
 * The renderer accesses this API through `window.invoker`.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { InvokerAPI } from './types.js';

const api: InvokerAPI = {
  loadPlan: (plan) => ipcRenderer.invoke('invoker:load-plan', plan),
  start: () => ipcRenderer.invoke('invoker:start'),
  stop: () => ipcRenderer.invoke('invoker:stop'),
  clear: () => ipcRenderer.invoke('invoker:clear'),
  getTasks: () => ipcRenderer.invoke('invoker:get-tasks'),
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
  editTaskType: (taskId, familiarType) =>
    ipcRenderer.invoke('invoker:edit-task-type', taskId, familiarType),
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
  getAllCompletedTasks: () => ipcRenderer.invoke('invoker:get-all-completed-tasks'),
  onWorkflowsChanged: (cb: (workflows: unknown[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, workflows: unknown[]) => cb(workflows);
    ipcRenderer.on('invoker:workflows-changed', handler);
    return () => ipcRenderer.removeListener('invoker:workflows-changed', handler);
  },
  restartWorkflow: (workflowId: string) =>
    ipcRenderer.invoke('invoker:restart-workflow', workflowId),
  rebaseAndRetry: (mergeTaskId: string) =>
    ipcRenderer.invoke('invoker:rebase-and-retry', mergeTaskId),
  setMergeBranch: (workflowId: string, baseBranch: string) =>
    ipcRenderer.invoke('invoker:set-merge-branch', workflowId, baseBranch),
  approveMerge: (workflowId: string) =>
    ipcRenderer.invoke('invoker:approve-merge', workflowId),
};

contextBridge.exposeInMainWorld('invoker', api);
