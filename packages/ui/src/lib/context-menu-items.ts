/**
 * Context menu item ordering and configuration.
 *
 * Status-adaptive ordering per docs/invoker-apple-reskin-research.md section 4.2:
 * - failed: "Fix with Claude" first (primary), then other fix agents, Restart, Replace
 * - running: "Open Terminal" first (primary)
 * - pending: "Restart Task" first (primary)
 * - completed/stale: "Open Terminal" first, then "Restart Task"
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
  separator?: 'workflow' | 'danger'; // labeled separator BEFORE this item
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
  const canReplace = task.status === 'failed' || task.status === 'blocked';
  const canOpenTerminal = !isExperimentSpawnPivotTask(task);
  const canFix = task.status === 'failed';
  const canCancel = task.status !== 'completed' && task.status !== 'stale';
  const hasWorkflow = !!task.config.workflowId;

  // ── Task-level items (status-adaptive ordering) ───────────────

  if (task.status === 'failed') {
    // Failed: Fix first (primary), then Restart, Replace, Open Terminal
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

    items.push({
      id: 'restart',
      label: 'Restart Task',
      enabled: canRestart,
      action: 'onRestart',
    });

    if (canReplace) {
      items.push({
        id: 'replace',
        label: 'Replace with...',
        enabled: true,
        action: 'onReplace',
      });
    }

    items.push({
      id: 'open-terminal',
      label: 'Open Terminal',
      enabled: canOpenTerminal,
      action: 'onOpenTerminal',
    });
  } else if (task.status === 'running') {
    // Running: Open Terminal first (primary), then Restart
    items.push({
      id: 'open-terminal',
      label: 'Open Terminal',
      enabled: canOpenTerminal,
      action: 'onOpenTerminal',
      variant: 'primary',
    });

    items.push({
      id: 'restart',
      label: 'Restart Task',
      enabled: canRestart,
      action: 'onRestart',
    });

    if (canReplace) {
      items.push({
        id: 'replace',
        label: 'Replace with...',
        enabled: true,
        action: 'onReplace',
      });
    }
  } else if (task.status === 'pending') {
    // Pending: Restart first (primary), then Replace, Open Terminal
    items.push({
      id: 'restart',
      label: 'Restart Task',
      enabled: canRestart,
      action: 'onRestart',
      variant: 'primary',
    });

    if (canReplace) {
      items.push({
        id: 'replace',
        label: 'Replace with...',
        enabled: true,
        action: 'onReplace',
      });
    }

    items.push({
      id: 'open-terminal',
      label: 'Open Terminal',
      enabled: canOpenTerminal,
      action: 'onOpenTerminal',
    });
  } else {
    // completed/stale: Open Terminal first, then Restart
    items.push({
      id: 'open-terminal',
      label: 'Open Terminal',
      enabled: canOpenTerminal,
      action: 'onOpenTerminal',
    });

    items.push({
      id: 'restart',
      label: 'Restart Task',
      enabled: canRestart,
      action: 'onRestart',
    });

    if (canReplace) {
      items.push({
        id: 'replace',
        label: 'Replace with...',
        enabled: true,
        action: 'onReplace',
      });
    }
  }

  // ── Workflow-level items (grouped with labeled separator) ─────

  if (hasWorkflow) {
    items.push({
      id: 'rebase-retry',
      label: 'Rebase & Retry',
      enabled: true,
      action: 'onRebaseAndRetry',
      variant: 'warning',
      separator: 'workflow',
    });

    items.push({
      id: 'retry-workflow',
      label: 'Retry Workflow (keep completed)',
      enabled: true,
      action: 'onRetryWorkflow',
      variant: 'warning',
    });
  }

  // ── Danger items (grouped with labeled separator) ─────────────

  if (canCancel) {
    items.push({
      id: 'cancel-task',
      label: 'Cancel Task (+ dependents)',
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
