/**
 * Context menu item ordering and configuration.
 *
 * Design:
 * - Failed tasks: fix actions first.
 * - Task actions are grouped in a dedicated "Task" section.
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
  separator?: 'task' | 'danger'; // labeled separator BEFORE this item
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

  const isCrashPreserved = Boolean(task.execution.crashPreservedAt);
  const canRestart = task.status !== 'running' || isCrashPreserved;
  const canOpenTerminal = !isExperimentSpawnPivotTask(task) && !isCrashPreserved;
  const canFix = task.status === 'failed';
  const canCancel = task.status !== 'completed' && task.status !== 'stale';

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
    if (isCrashPreserved) {
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

  if (task.config.workflowId) {
    items.push({
      id: 'recreate-task',
      label: 'Recreate from Task',
      enabled: true,
      action: 'onRecreateTask',
      variant: 'danger',
      separator: !canCancel ? 'danger' : undefined,
    });

    items.push({
      id: 'recreate-downstream',
      label: 'Recreate Downstream',
      enabled: task.status !== 'running',
      action: 'onRecreateDownstream',
      variant: 'danger',
    });

    items.push({
      id: 'delete-task',
      label: 'Delete Task',
      enabled: true,
      action: 'onDelete',
      variant: 'danger',
    });
  }

  return items;
}
