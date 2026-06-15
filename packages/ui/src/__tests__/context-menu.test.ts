import { describe, it, expect } from 'vitest';
import type { TaskState } from '../types.js';
import { getMenuItems } from '../lib/context-menu-items.js';

function makeTask(overrides: Partial<TaskState> & { workflowId?: string; isMergeNode?: boolean } = {}): TaskState {
  const { workflowId, isMergeNode, ...rest } = overrides;
  return {
    id: 'test',
    description: 'Test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId, isMergeNode },
    execution: {},
    ...rest,
  } as TaskState;
}

describe('ContextMenu getMenuItems', () => {
  describe('Status-adaptive ordering', () => {
    it('failed task: first item is "Fix with Claude" (primary)', () => {
      const task = makeTask({ status: 'failed' });
      const items = getMenuItems(task, { agents: ['claude', 'codex'] });

      expect(items[0].label).toBe('Fix with Claude');
      expect(items[0].variant).toBe('primary');
      expect(items[0].action).toBe('onFix');
      expect(items[0].agentName).toBe('claude');
    });

    it('running task: first item is "Open Terminal" (primary)', () => {
      const task = makeTask({ status: 'running' });
      const items = getMenuItems(task);

      expect(items[0].label).toBe('Open Terminal');
      expect(items[0].variant).toBe('primary');
      expect(items[0].action).toBe('onOpenTerminal');
    });

    it('pending task: first item is "Restart Task" (primary)', () => {
      const task = makeTask({ status: 'pending' });
      const items = getMenuItems(task);

      expect(items[0].label).toBe('Restart Task');
      expect(items[0].variant).toBe('primary');
      expect(items[0].action).toBe('onRestart');
    });

    it('completed task: first item is "Open Terminal"', () => {
      const task = makeTask({ status: 'completed' });
      const items = getMenuItems(task);

      expect(items[0].label).toBe('Open Terminal');
      expect(items[0].action).toBe('onOpenTerminal');
    });

    it('stale task: first item is "Open Terminal"', () => {
      const task = makeTask({ status: 'stale' });
      const items = getMenuItems(task);

      expect(items[0].label).toBe('Open Terminal');
      expect(items[0].action).toBe('onOpenTerminal');
    });
  });

  describe('Labeled separators', () => {
    it('does not add a workflow separator to task menus', () => {
      const task = makeTask({ status: 'failed', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      expect(items.some((item) => (item.separator as string | undefined) === 'workflow')).toBe(false);
    });

    it('danger items have "danger" separator before first danger item', () => {
      const task = makeTask({ status: 'failed', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const cancelItem = items.find((item) => item.id === 'cancel-task');
      expect(cancelItem?.separator).toBe('danger');
    });

    it('danger separator appears on first danger item even without cancel', () => {
      const task = makeTask({ status: 'completed', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      // Completed task has no cancel item
      const cancelItem = items.find((item) => item.id === 'cancel-task');
      expect(cancelItem).toBeUndefined();

      // Recreate task should have danger separator
      const recreateItem = items.find((item) => item.id === 'recreate-task');
      expect(recreateItem?.separator).toBe('danger');
    });
  });

  describe('Workflow-owned item visibility', () => {
    it('workflow-wide actions do not appear in task menus even when workflowId is set', () => {
      const taskWithWorkflow = makeTask({ status: 'failed', workflowId: 'wf-1' });
      const itemsWithWorkflow = getMenuItems(taskWithWorkflow);

      const workflowItemIds = ['rebase-retry', 'rebase-recreate', 'retry-workflow', 'recreate-workflow', 'cancel-workflow', 'delete-workflow'];
      workflowItemIds.forEach((id) => {
        expect(itemsWithWorkflow.find((i) => i.id === id)).toBeUndefined();
      });
    });

    it('workflow-wide actions do not appear for merge nodes', () => {
      const task = makeTask({ id: '__merge__wf-1', status: 'failed', isMergeNode: true, workflowId: 'wf-1' });
      const items = getMenuItems(task);

      expect(items.find((item) => item.id === 'retry-workflow')).toBeUndefined();
      expect(items.find((item) => item.id === 'recreate-workflow')).toBeUndefined();
      expect(items.find((item) => item.id === 'cancel-workflow')).toBeUndefined();
      expect(items.find((item) => item.id === 'delete-workflow')).toBeUndefined();
    });

    it('keeps Recreate from Task as the task-scoped workflowId action', () => {
      const task = makeTask({ status: 'failed', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const recreateTask = items.find((item) => item.id === 'recreate-task');
      expect(recreateTask).toBeDefined();
      expect(recreateTask?.action).toBe('onRecreateTask');
    });

    it('shows Recreate Downstream for workflow-owned tasks', () => {
      const task = makeTask({ status: 'failed', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const recreateDownstream = items.find((item) => item.id === 'recreate-downstream');
      expect(recreateDownstream).toBeDefined();
      expect(recreateDownstream).toMatchObject({
        label: 'Recreate Downstream',
        enabled: true,
        action: 'onRecreateDownstream',
        variant: 'danger',
      });
    });

    it('hides Recreate Downstream for non-workflow tasks', () => {
      const task = makeTask({ status: 'failed' });
      const items = getMenuItems(task);

      expect(items.find((item) => item.id === 'recreate-downstream')).toBeUndefined();
    });

    it('disables Recreate Downstream while the task is running', () => {
      const task = makeTask({ status: 'running', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const recreateDownstream = items.find((item) => item.id === 'recreate-downstream');
      expect(recreateDownstream).toBeDefined();
      expect(recreateDownstream?.enabled).toBe(false);
    });
  });

  describe('Restart visibility', () => {
    it('allows restart for non-running tasks', () => {
      const task = makeTask({ status: 'failed' });
      const items = getMenuItems(task);

      const restartItem = items.find((item) => item.id === 'restart');
      expect(restartItem?.enabled).toBe(true);
    });

    it('disables restart for running tasks', () => {
      const task = makeTask({ status: 'running' });
      const items = getMenuItems(task);

      const restartItem = items.find((item) => item.id === 'restart');
      expect(restartItem?.enabled).toBe(false);
    });
  });

  describe('Replace visibility', () => {
    it('does not include replace action for failed tasks', () => {
      const task = makeTask({ status: 'failed' });
      const items = getMenuItems(task);
      expect(items.find((item) => item.id === 'replace')).toBeUndefined();
    });

    it('does not include replace action for blocked tasks', () => {
      const task = makeTask({ status: 'blocked' });
      const items = getMenuItems(task);
      expect(items.find((item) => item.id === 'replace')).toBeUndefined();
    });
  });

  describe('Fix with... visibility', () => {
    it('is visible for failed task', () => {
      const task = makeTask({ status: 'failed' }) as TaskState;
      const items = getMenuItems(task, { agents: ['claude', 'codex'] });

      const claudeFixItem = items.find((item) => item.id === 'fix-claude');
      const codexFixItem = items.find((item) => item.id === 'fix-codex');

      expect(claudeFixItem).toBeDefined();
      expect(codexFixItem).toBeDefined();
      expect(claudeFixItem?.enabled).toBe(true);
      expect(codexFixItem?.enabled).toBe(true);
    });

    it('is visible for failed task with merge conflict', () => {
      const task = makeTask({
        status: 'failed',
        execution: { mergeConflict: { failedBranch: 'b', conflictFiles: ['f'] } },
      } as any);
      const items = getMenuItems(task);

      const fixItem = items.find((item) => item.action === 'onFix');
      expect(fixItem).toBeDefined();
    });

    it('is visible for failed merge gate node', () => {
      const task = makeTask({ status: 'failed', isMergeNode: true, workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const fixItem = items.find((item) => item.action === 'onFix');
      expect(fixItem).toBeDefined();
    });

    it('is hidden for non-failed statuses', () => {
      for (const status of ['pending', 'running', 'completed', 'blocked'] as const) {
        const task = makeTask({ status });
        const items = getMenuItems(task);

        const fixItem = items.find((item) => item.action === 'onFix');
        expect(fixItem).toBeUndefined();
      }
    });
  });

  describe('Item variants', () => {
    it('assigns primary variant to first item based on status', () => {
      const failedTask = makeTask({ status: 'failed' });
      const failedItems = getMenuItems(failedTask);
      expect(failedItems[0].variant).toBe('primary'); // Fix with Claude

      const runningTask = makeTask({ status: 'running' });
      const runningItems = getMenuItems(runningTask);
      expect(runningItems[0].variant).toBe('primary'); // Open Terminal

      const pendingTask = makeTask({ status: 'pending' });
      const pendingItems = getMenuItems(pendingTask);
      expect(pendingItems[0].variant).toBe('primary'); // Restart Task
    });

    it('does not assign workflow warning variants in task menus', () => {
      const task = makeTask({ status: 'failed', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      expect(items.some((item) => item.variant === 'warning')).toBe(false);
    });

    it('assigns danger variant to danger items', () => {
      const task = makeTask({ status: 'failed', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const dangerIds = ['cancel-task', 'recreate-task', 'recreate-downstream'];
      dangerIds.forEach((id) => {
        const item = items.find((i) => i.id === id);
        expect(item?.variant).toBe('danger');
      });
    });
  });
});
