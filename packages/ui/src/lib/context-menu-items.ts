/**
 * Context menu item ordering and configuration.
 *
 * Design:
 * - Failed tasks: fix actions first.
 * - Task actions are grouped in a dedicated "Task" section.
 * - Workflow actions are grouped in a "Workflow" section.
 * - Dangerous actions are grouped in a "Danger" section (UI can collapse behind "More").
 * - No "Replace with..." action.
 */

import type { TaskState } from '../types.js';
import { isExperimentSpawnPivotTask } from '../isExperimentSpawnPivot.js';

export interface MenuItem {
  id: string;
  label: string;
  enabled: boolean;
  action: string; // handler key, e.g. 'onRestart', 'onFix'
  agentName?: string; // for fix items
  variant?: 'default' | 'primary' | 'warning' | 'danger';
  separator?: 'task' | 'workflow' | 'danger'; // labeled separator BEFORE this item
}

export interface GetMenuItemsOptions {
  agents?: string[];
}

/**
 * Generate menu items based on task state.
 * Items are ordered by most likely user intent for the given task status.
 */
export function getMenuItems(
  task: TaskState,
  options: GetMenuItemsOptions = {}
): MenuItem[] {
  const { agents = ['claude', 'codex'] } = options;
  const items: MenuItem[] = [];

  const canRestart = task.status !== 'running';
  const canOpenTerminal = !isExperimentSpawnPivotTask(task);
  const canFix = task.status === 'failed';
  const canCancel = task.status !== 'completed' && task.status !== 'stale';
  const hasWorkflow = !!task.config.workflowId;

  // ── Fix actions (top, only for failed) ────────────────────────
  if (canFix) {
    agents.forEach((agentName, idx) => {
      items.push({
        id: `fix-${agentName}`,
        label: `Fix with ${agentName.charAt(0).toUpperCase() + agentName.slice(1)}`,
        enabled: true,
        action: 'onFix',
        agentName,
        variant: idx === 0 ? 'primary' : 'default',
      });
    });
  }

  // ── Task actions (grouped) ────────────────────────────────────
  if (task.status === 'running') {
    items.push({
      id: 'open-terminal',
      label: 'Open Terminal',
      enabled: canOpenTerminal,
      action: 'onOpenTerminal',
      variant: !canFix ? 'primary' : 'default',
      separator: 'task',
    });

    items.push({
      id: 'restart',
      label: 'Restart Task',
      enabled: canRestart,
      action: 'onRestart',
    });
  } else if (task.status === 'pending') {
    items.push({
      id: 'restart',
      label: 'Restart Task',
      enabled: canRestart,
      action: 'onRestart',
      variant: !canFix ? 'primary' : 'default',
      separator: 'task',
    });

    items.push({
      id: 'open-terminal',
      label: 'Open Terminal',
      enabled: canOpenTerminal,
      action: 'onOpenTerminal',
    });
  } else {
    // failed/completed/stale/blocked/etc: open terminal then restart
    items.push({
      id: 'open-terminal',
      label: 'Open Terminal',
      enabled: canOpenTerminal,
      action: 'onOpenTerminal',
      variant: !canFix ? 'primary' : 'default',
      separator: 'task',
    });

    items.push({
      id: 'restart',
      label: 'Restart Task',
      enabled: canRestart,
      action: 'onRestart',
    });
  }

  // ── Workflow-level items (grouped) ───────────────────────────
  if (hasWorkflow) {
    items.push({
      id: 'rebase-retry',
      label: 'Retry with Rebase',
      enabled: true,
      action: 'onRebaseAndRetry',
      variant: 'warning',
      separator: 'workflow',
    });

    items.push({
      id: 'retry-workflow',
      label: 'Retry',
      enabled: true,
      action: 'onRetryWorkflow',
      variant: 'warning',
    });
  }

  // ── Danger items (grouped; UI may hide behind More) ──────────
  if (canCancel) {
    items.push({
      id: 'cancel-task',
      label: 'Terminate Task',
      enabled: true,
      action: 'onCancel',
      variant: 'danger',
      separator: 'danger',
    });
  }

  if (hasWorkflow) {
    items.push({
      id: 'recreate-task',
      label: 'Recreate from Task',
      enabled: true,
      action: 'onRecreateTask',
      variant: 'danger',
      separator: !canCancel ? 'danger' : undefined,
    });

    items.push({
      id: 'recreate-workflow',
      label: 'Recreate Workflow',
      enabled: true,
      action: 'onRecreateWorkflow',
      variant: 'danger',
    });

    items.push({
      id: 'cancel-workflow',
      label: 'Cancel Workflow',
      enabled: true,
      action: 'onCancelWorkflow',
      variant: 'danger',
    });

    items.push({
      id: 'delete-workflow',
      label: 'Delete Workflow',
      enabled: true,
      action: 'onDeleteWorkflow',
      variant: 'danger',
    });
  }

  return items;
}
