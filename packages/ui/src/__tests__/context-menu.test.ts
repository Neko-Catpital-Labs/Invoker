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
    it('workflow items have "workflow" separator before first item', () => {
      const task = makeTask({ status: 'failed', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const rebaseItem = items.find((item) => item.id === 'rebase-retry');
      expect(rebaseItem?.separator).toBe('workflow');
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

  describe('Workflow items visibility', () => {
    it('workflow items only appear when workflowId is set', () => {
      const taskWithWorkflow = makeTask({ status: 'failed', workflowId: 'wf-1' });
      const itemsWithWorkflow = getMenuItems(taskWithWorkflow);

      const rebaseItem = itemsWithWorkflow.find((item) => item.id === 'rebase-retry');
      expect(rebaseItem).toBeDefined();

      const taskWithoutWorkflow = makeTask({ status: 'failed' });
      const itemsWithoutWorkflow = getMenuItems(taskWithoutWorkflow);

      const noRebaseItem = itemsWithoutWorkflow.find((item) => item.id === 'rebase-retry');
      expect(noRebaseItem).toBeUndefined();
    });

    it('workflow items appear for merge nodes', () => {
      const task = makeTask({ id: '__merge__wf-1', status: 'failed', isMergeNode: true, workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const rebaseItem = items.find((item) => item.id === 'rebase-retry');
      expect(rebaseItem).toBeDefined();
      expect(rebaseItem?.action).toBe('onRebaseAndRetry');
    });

    it('all workflow items are present when workflowId exists', () => {
      const task = makeTask({ status: 'failed', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const workflowItemIds = ['rebase-retry', 'retry-workflow', 'recreate-task', 'recreate-workflow', 'cancel-workflow', 'delete-workflow'];
      workflowItemIds.forEach((id) => {
        const item = items.find((i) => i.id === id);
        expect(item).toBeDefined();
      });
    });
  });

  describe('Rebase & Retry visibility', () => {
    it('is visible for any task with a workflowId', () => {
      const task = makeTask({ id: 'regular-task', status: 'failed', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const rebaseItem = items.find((item) => item.id === 'rebase-retry');
      expect(rebaseItem).toBeDefined();
      expect(rebaseItem?.enabled).toBe(true);
    });

    it('is visible for merge nodes with a workflowId', () => {
      const task = makeTask({ id: '__merge__wf-1', status: 'failed', isMergeNode: true, workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const rebaseItem = items.find((item) => item.id === 'rebase-retry');
      expect(rebaseItem).toBeDefined();
      expect(rebaseItem?.enabled).toBe(true);
    });

    it('is visible regardless of task status', () => {
      for (const status of ['pending', 'running', 'completed', 'failed'] as const) {
        const task = makeTask({ id: 'task-1', status, workflowId: 'wf-1' });
        const items = getMenuItems(task);

        const rebaseItem = items.find((item) => item.id === 'rebase-retry');
        expect(rebaseItem).toBeDefined();
      }
    });

    it('is hidden for tasks without a workflowId', () => {
      const task = makeTask({ id: 'orphan-task', status: 'failed' });
      const items = getMenuItems(task);

      const rebaseItem = items.find((item) => item.id === 'rebase-retry');
      expect(rebaseItem).toBeUndefined();
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
    it('allows replace for failed tasks', () => {
      const task = makeTask({ status: 'failed' });
      const items = getMenuItems(task);

      const replaceItem = items.find((item) => item.id === 'replace');
      expect(replaceItem).toBeDefined();
      expect(replaceItem?.enabled).toBe(true);
    });

    it('allows replace for blocked tasks', () => {
      const task = makeTask({ status: 'blocked' });
      const items = getMenuItems(task);

      const replaceItem = items.find((item) => item.id === 'replace');
      expect(replaceItem).toBeDefined();
      expect(replaceItem?.enabled).toBe(true);
    });

    it('disallows replace for running tasks', () => {
      const task = makeTask({ status: 'running' });
      const items = getMenuItems(task);

      const replaceItem = items.find((item) => item.id === 'replace');
      expect(replaceItem).toBeUndefined();
    });
  });

  describe('Recreate Workflow visibility', () => {
    it('is visible for any node with a workflowId', () => {
      const task = makeTask({ id: 'regular-task', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const recreateItem = items.find((item) => item.id === 'recreate-workflow');
      expect(recreateItem).toBeDefined();
      expect(recreateItem?.enabled).toBe(true);
    });

    it('is visible for merge nodes with a workflowId', () => {
      const task = makeTask({ id: '__merge__wf-1', isMergeNode: true, workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const recreateItem = items.find((item) => item.id === 'recreate-workflow');
      expect(recreateItem).toBeDefined();
      expect(recreateItem?.enabled).toBe(true);
    });

    it('is hidden when task has no workflowId', () => {
      const task = makeTask({ id: 'orphan-task' });
      const items = getMenuItems(task);

      const recreateItem = items.find((item) => item.id === 'recreate-workflow');
      expect(recreateItem).toBeUndefined();
    });

    it('is visible regardless of task status', () => {
      for (const status of ['pending', 'running', 'completed', 'failed'] as const) {
        const task = makeTask({ id: 'task-1', status, workflowId: 'wf-1' });
        const items = getMenuItems(task);

        const recreateItem = items.find((item) => item.id === 'recreate-workflow');
        expect(recreateItem).toBeDefined();
      }
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

  describe('Delete Workflow visibility', () => {
    it('is visible for any node with a workflowId', () => {
      const task = makeTask({ id: 'regular-task', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const deleteItem = items.find((item) => item.id === 'delete-workflow');
      expect(deleteItem).toBeDefined();
      expect(deleteItem?.enabled).toBe(true);
    });

    it('is visible for merge nodes with a workflowId', () => {
      const task = makeTask({ id: '__merge__wf-1', isMergeNode: true, workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const deleteItem = items.find((item) => item.id === 'delete-workflow');
      expect(deleteItem).toBeDefined();
      expect(deleteItem?.enabled).toBe(true);
    });

    it('is hidden when task has no workflowId', () => {
      const task = makeTask({ id: 'orphan-task' });
      const items = getMenuItems(task);

      const deleteItem = items.find((item) => item.id === 'delete-workflow');
      expect(deleteItem).toBeUndefined();
    });

    it('is visible regardless of task status', () => {
      for (const status of ['pending', 'running', 'completed', 'failed'] as const) {
        const task = makeTask({ id: 'task-1', status, workflowId: 'wf-1' });
        const items = getMenuItems(task);

        const deleteItem = items.find((item) => item.id === 'delete-workflow');
        expect(deleteItem).toBeDefined();
      }
    });
  });

  describe('Cancel Workflow visibility', () => {
    it('is visible for any node with a workflowId', () => {
      const task = makeTask({ id: 'regular-task', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const cancelItem = items.find((item) => item.id === 'cancel-workflow');
      expect(cancelItem).toBeDefined();
      expect(cancelItem?.enabled).toBe(true);
    });

    it('is hidden when task has no workflowId', () => {
      const task = makeTask({ id: 'orphan-task' });
      const items = getMenuItems(task);

      const cancelItem = items.find((item) => item.id === 'cancel-workflow');
      expect(cancelItem).toBeUndefined();
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

    it('assigns warning variant to workflow items', () => {
      const task = makeTask({ status: 'failed', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const rebaseItem = items.find((item) => item.id === 'rebase-retry');
      const retryItem = items.find((item) => item.id === 'retry-workflow');

      expect(rebaseItem?.variant).toBe('warning');
      expect(retryItem?.variant).toBe('warning');
    });

    it('assigns danger variant to danger items', () => {
      const task = makeTask({ status: 'failed', workflowId: 'wf-1' });
      const items = getMenuItems(task);

      const dangerIds = ['cancel-task', 'recreate-task', 'recreate-workflow', 'cancel-workflow', 'delete-workflow'];
      dangerIds.forEach((id) => {
        const item = items.find((i) => i.id === id);
        expect(item?.variant).toBe('danger');
      });
    });
  });
});
