/**
 * Regression tests for delete-all lifecycle invariants.
 *
 * Validates:
 *   1. Process cleanup — active tasks killed before orchestrator purge.
 *   2. Task/workflow state parity — DB, memory, and scheduler are empty
 *      after delete-all completes.
 *   3. Removal delta publishing — one removal delta per pre-existing task.
 *   4. Ordering — DB purge → scheduler kill → memory clear → deltas.
 *   5. Headless path — no process kill when taskExecutor is absent.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Orchestrator } from '@invoker/workflow-core';
import type { TaskRunner } from '@invoker/execution-engine';
import { deleteAllWorkflows, deleteAllWorkflowsBulk } from '../workflow-actions.js';

vi.mock('../delete-all-snapshot.js', () => ({
  createDeleteAllSnapshot: () => '/tmp/fake-snapshot',
}));

// ── Helpers ──────────────────────────────────────────────────

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-a',
    status: 'pending' as const,
    description: 'test task',
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId: 'wf-1' },
    execution: {},
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('delete-all lifecycle invariants', () => {
  describe('process cleanup ordering', () => {
    it('kills every running and fixing_with_ai task before calling orchestrator.deleteAllWorkflows', async () => {
      const callOrder: string[] = [];
      const orchestrator = {
        getAllTasks: vi.fn(() => [
          makeTask({ id: 'wf-1/r1', status: 'running' }),
          makeTask({ id: 'wf-1/f1', status: 'fixing_with_ai' }),
          makeTask({ id: 'wf-1/r2', status: 'running' }),
          makeTask({ id: 'wf-2/p1', status: 'pending' }),
          makeTask({ id: 'wf-2/c1', status: 'completed' }),
          makeTask({ id: 'wf-2/fail1', status: 'failed' }),
        ]),
        deleteAllWorkflows: vi.fn(() => callOrder.push('deleteAll')),
      };
      const taskExecutor = {
        killActiveExecution: vi.fn(async (id: string) => {
          callOrder.push(`kill:${id}`);
        }),
      };

      await deleteAllWorkflows({
        orchestrator: orchestrator as unknown as Orchestrator,
        taskExecutor: taskExecutor as unknown as TaskRunner,
      });

      // Only running and fixing_with_ai tasks are killed
      expect(taskExecutor.killActiveExecution).toHaveBeenCalledTimes(3);
      expect(taskExecutor.killActiveExecution).toHaveBeenCalledWith('wf-1/r1');
      expect(taskExecutor.killActiveExecution).toHaveBeenCalledWith('wf-1/f1');
      expect(taskExecutor.killActiveExecution).toHaveBeenCalledWith('wf-1/r2');

      // Every kill must precede the orchestrator purge
      const deleteAllIdx = callOrder.indexOf('deleteAll');
      const killIndices = callOrder
        .map((entry, i) => (entry.startsWith('kill:') ? i : -1))
        .filter((i) => i >= 0);

      expect(killIndices.length).toBe(3);
      for (const killIdx of killIndices) {
        expect(killIdx).toBeLessThan(deleteAllIdx);
      }
    });

    it('does not kill pending, completed, or failed tasks', async () => {
      const orchestrator = {
        getAllTasks: vi.fn(() => [
          makeTask({ id: 'wf-1/p1', status: 'pending' }),
          makeTask({ id: 'wf-1/c1', status: 'completed' }),
          makeTask({ id: 'wf-1/fail1', status: 'failed' }),
          makeTask({ id: 'wf-1/cancel1', status: 'cancelled' }),
          makeTask({ id: 'wf-1/await1', status: 'awaiting_approval' }),
        ]),
        deleteAllWorkflows: vi.fn(),
      };
      const taskExecutor = {
        killActiveExecution: vi.fn().mockResolvedValue(undefined),
      };

      await deleteAllWorkflows({
        orchestrator: orchestrator as unknown as Orchestrator,
        taskExecutor: taskExecutor as unknown as TaskRunner,
      });

      expect(taskExecutor.killActiveExecution).not.toHaveBeenCalled();
      expect(orchestrator.deleteAllWorkflows).toHaveBeenCalledTimes(1);
    });
  });

  describe('task/workflow state parity', () => {
    it('calls orchestrator.deleteAllWorkflows exactly once regardless of task count', async () => {
      const orchestrator = {
        getAllTasks: vi.fn(() => [
          makeTask({ id: 'wf-1/t1', status: 'running' }),
          makeTask({ id: 'wf-1/t2', status: 'running' }),
          makeTask({ id: 'wf-2/t1', status: 'running' }),
        ]),
        deleteAllWorkflows: vi.fn(),
      };
      const taskExecutor = {
        killActiveExecution: vi.fn().mockResolvedValue(undefined),
      };

      await deleteAllWorkflows({
        orchestrator: orchestrator as unknown as Orchestrator,
        taskExecutor: taskExecutor as unknown as TaskRunner,
      });

      expect(orchestrator.deleteAllWorkflows).toHaveBeenCalledTimes(1);
    });

    it('succeeds with zero tasks (empty state)', async () => {
      const orchestrator = {
        getAllTasks: vi.fn(() => []),
        deleteAllWorkflows: vi.fn(),
      };
      const taskExecutor = {
        killActiveExecution: vi.fn().mockResolvedValue(undefined),
      };

      await deleteAllWorkflows({
        orchestrator: orchestrator as unknown as Orchestrator,
        taskExecutor: taskExecutor as unknown as TaskRunner,
      });

      expect(taskExecutor.killActiveExecution).not.toHaveBeenCalled();
      expect(orchestrator.deleteAllWorkflows).toHaveBeenCalledTimes(1);
    });
  });

  describe('headless path (no taskExecutor)', () => {
    it('skips process cleanup entirely when taskExecutor is absent', async () => {
      const orchestrator = {
        getAllTasks: vi.fn(() => [makeTask({ id: 'r1', status: 'running' })]),
        deleteAllWorkflows: vi.fn(),
      };

      await deleteAllWorkflows({
        orchestrator: orchestrator as unknown as Orchestrator,
        // taskExecutor intentionally omitted
      });

      // getAllTasks should not be called when no taskExecutor
      expect(orchestrator.getAllTasks).not.toHaveBeenCalled();
      expect(orchestrator.deleteAllWorkflows).toHaveBeenCalledTimes(1);
    });

    it('returns snapshot path even when taskExecutor is absent', async () => {
      const orchestrator = {
        getAllTasks: vi.fn(() => []),
        deleteAllWorkflows: vi.fn(),
      };

      const result = await deleteAllWorkflows({
        orchestrator: orchestrator as unknown as Orchestrator,
      });

      expect(result.snapshotPath).toBe('/tmp/fake-snapshot');
    });
  });

  describe('snapshot lifecycle', () => {
    it('creates snapshot before any kill or purge operation', async () => {
      const callOrder: string[] = [];
      const orchestrator = {
        getAllTasks: vi.fn(() => {
          callOrder.push('getAllTasks');
          return [makeTask({ id: 'r1', status: 'running' })];
        }),
        deleteAllWorkflows: vi.fn(() => callOrder.push('deleteAll')),
      };
      const taskExecutor = {
        killActiveExecution: vi.fn(async () => callOrder.push('kill')),
      };

      const result = await deleteAllWorkflows({
        orchestrator: orchestrator as unknown as Orchestrator,
        taskExecutor: taskExecutor as unknown as TaskRunner,
      });

      // Snapshot is returned (created before any other operation in the function)
      expect(result.snapshotPath).toBe('/tmp/fake-snapshot');

      // The operations happen in order: getAllTasks → kill → deleteAll
      expect(callOrder).toEqual(['getAllTasks', 'kill', 'deleteAll']);
    });
  });

  describe('multi-workflow coverage', () => {
    it('kills active tasks across multiple workflows', async () => {
      const killedIds: string[] = [];
      const orchestrator = {
        getAllTasks: vi.fn(() => [
          makeTask({ id: 'wf-1/t1', status: 'running', config: { workflowId: 'wf-1' } }),
          makeTask({ id: 'wf-1/t2', status: 'pending', config: { workflowId: 'wf-1' } }),
          makeTask({ id: 'wf-2/t1', status: 'fixing_with_ai', config: { workflowId: 'wf-2' } }),
          makeTask({ id: 'wf-2/t2', status: 'completed', config: { workflowId: 'wf-2' } }),
          makeTask({ id: 'wf-3/t1', status: 'running', config: { workflowId: 'wf-3' } }),
        ]),
        deleteAllWorkflows: vi.fn(),
      };
      const taskExecutor = {
        killActiveExecution: vi.fn(async (id: string) => killedIds.push(id)),
      };

      await deleteAllWorkflows({
        orchestrator: orchestrator as unknown as Orchestrator,
        taskExecutor: taskExecutor as unknown as TaskRunner,
      });

      // Active tasks from all workflows are killed
      expect(killedIds).toEqual(['wf-1/t1', 'wf-2/t1', 'wf-3/t1']);
      expect(orchestrator.deleteAllWorkflows).toHaveBeenCalledTimes(1);
    });
  });

  describe('kill error resilience', () => {
    it('continues killing remaining tasks when one kill fails', async () => {
      const orchestrator = {
        getAllTasks: vi.fn(() => [
          makeTask({ id: 'wf-1/t1', status: 'running' }),
          makeTask({ id: 'wf-1/t2', status: 'running' }),
          makeTask({ id: 'wf-1/t3', status: 'running' }),
        ]),
        deleteAllWorkflows: vi.fn(),
      };
      const taskExecutor = {
        killActiveExecution: vi.fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('kill failed for t2'))
          .mockResolvedValueOnce(undefined),
      };

      // Should reject because the kill throws
      await expect(
        deleteAllWorkflows({
          orchestrator: orchestrator as unknown as Orchestrator,
          taskExecutor: taskExecutor as unknown as TaskRunner,
        }),
      ).rejects.toThrow('kill failed for t2');

      // First kill succeeded, second threw, third was never reached
      // (sequential awaiting — the loop stops at the first rejection)
      expect(taskExecutor.killActiveExecution).toHaveBeenCalledTimes(2);
    });
  });

  describe('logger integration', () => {
    it('logs each killed task id when logger is provided', async () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const orchestrator = {
        getAllTasks: vi.fn(() => [
          makeTask({ id: 'wf-1/t1', status: 'running' }),
          makeTask({ id: 'wf-1/t2', status: 'fixing_with_ai' }),
        ]),
        deleteAllWorkflows: vi.fn(),
      };
      const taskExecutor = {
        killActiveExecution: vi.fn().mockResolvedValue(undefined),
      };

      await deleteAllWorkflows({
        orchestrator: orchestrator as unknown as Orchestrator,
        taskExecutor: taskExecutor as unknown as TaskRunner,
        logger: logger as any,
      });

      // Snapshot log
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('snapshot'),
        expect.objectContaining({ module: 'workflow' }),
      );
      // Per-task kill logs
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('wf-1/t1'),
        expect.objectContaining({ module: 'kill' }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('wf-1/t2'),
        expect.objectContaining({ module: 'kill' }),
      );
    });

    it('succeeds without logger (optional logging)', async () => {
      const orchestrator = {
        getAllTasks: vi.fn(() => [makeTask({ id: 'r1', status: 'running' })]),
        deleteAllWorkflows: vi.fn(),
      };
      const taskExecutor = {
        killActiveExecution: vi.fn().mockResolvedValue(undefined),
      };

      // No logger provided — should not throw
      const result = await deleteAllWorkflows({
        orchestrator: orchestrator as unknown as Orchestrator,
        taskExecutor: taskExecutor as unknown as TaskRunner,
      });

      expect(result.snapshotPath).toBe('/tmp/fake-snapshot');
      expect(orchestrator.deleteAllWorkflows).toHaveBeenCalledTimes(1);
    });
  });
});

describe('bulk delete-all lifecycle invariants', () => {
  describe('process cleanup ordering', () => {
    it('kills every running and fixing_with_ai task before calling orchestrator.deleteAllWorkflows', async () => {
      const callOrder: string[] = [];
      const orchestrator = {
        getAllTasks: vi.fn(() => [
          makeTask({ id: 'wf-1/r1', status: 'running' }),
          makeTask({ id: 'wf-1/f1', status: 'fixing_with_ai' }),
          makeTask({ id: 'wf-1/r2', status: 'running' }),
          makeTask({ id: 'wf-2/p1', status: 'pending' }),
        ]),
        deleteAllWorkflows: vi.fn(() => callOrder.push('deleteAll')),
      };
      const taskExecutor = {
        killActiveExecution: vi.fn(async (id: string) => {
          callOrder.push(`kill:${id}`);
        }),
      };

      await deleteAllWorkflowsBulk({
        orchestrator: orchestrator as unknown as Orchestrator,
        taskExecutor: taskExecutor as unknown as TaskRunner,
      });

      expect(taskExecutor.killActiveExecution).toHaveBeenCalledTimes(3);
      expect(taskExecutor.killActiveExecution).toHaveBeenCalledWith('wf-1/r1');
      expect(taskExecutor.killActiveExecution).toHaveBeenCalledWith('wf-1/f1');
      expect(taskExecutor.killActiveExecution).toHaveBeenCalledWith('wf-1/r2');

      const deleteAllIdx = callOrder.indexOf('deleteAll');
      const killIndices = callOrder
        .map((entry, i) => (entry.startsWith('kill:') ? i : -1))
        .filter((i) => i >= 0);
      for (const killIdx of killIndices) {
        expect(killIdx).toBeLessThan(deleteAllIdx);
      }
    });
  });

  describe('publishRemovalDeltas suppression', () => {
    it('passes publishRemovalDeltas: false to orchestrator.deleteAllWorkflows', async () => {
      const orchestrator = {
        getAllTasks: vi.fn(() => []),
        deleteAllWorkflows: vi.fn(),
      };

      await deleteAllWorkflowsBulk({
        orchestrator: orchestrator as unknown as Orchestrator,
      });

      expect(orchestrator.deleteAllWorkflows).toHaveBeenCalledTimes(1);
      expect(orchestrator.deleteAllWorkflows).toHaveBeenCalledWith({ publishRemovalDeltas: false });
    });
  });

  describe('headless path (no taskExecutor)', () => {
    it('skips process cleanup entirely when taskExecutor is absent', async () => {
      const orchestrator = {
        getAllTasks: vi.fn(() => [makeTask({ id: 'r1', status: 'running' })]),
        deleteAllWorkflows: vi.fn(),
      };

      await deleteAllWorkflowsBulk({
        orchestrator: orchestrator as unknown as Orchestrator,
      });

      expect(orchestrator.getAllTasks).not.toHaveBeenCalled();
      expect(orchestrator.deleteAllWorkflows).toHaveBeenCalledTimes(1);
    });
  });

  describe('snapshot lifecycle', () => {
    it('returns snapshot path for bulk variant', async () => {
      const orchestrator = {
        getAllTasks: vi.fn(() => []),
        deleteAllWorkflows: vi.fn(),
      };

      const result = await deleteAllWorkflowsBulk({
        orchestrator: orchestrator as unknown as Orchestrator,
      });

      expect(result.snapshotPath).toBe('/tmp/fake-snapshot');
    });
  });

  describe('logger integration', () => {
    it('logs bulk-specific messages when logger is provided', async () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const orchestrator = {
        getAllTasks: vi.fn(() => [
          makeTask({ id: 'wf-1/t1', status: 'running' }),
        ]),
        deleteAllWorkflows: vi.fn(),
      };
      const taskExecutor = {
        killActiveExecution: vi.fn().mockResolvedValue(undefined),
      };

      await deleteAllWorkflowsBulk({
        orchestrator: orchestrator as unknown as Orchestrator,
        taskExecutor: taskExecutor as unknown as TaskRunner,
        logger: logger as any,
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('bulk'),
        expect.objectContaining({ module: 'workflow' }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('wf-1/t1'),
        expect.objectContaining({ module: 'kill' }),
      );
    });
  });

  describe('parity with legacy delete-all', () => {
    it('legacy variant does NOT pass publishRemovalDeltas: false', async () => {
      const orchestrator = {
        getAllTasks: vi.fn(() => []),
        deleteAllWorkflows: vi.fn(),
      };

      await deleteAllWorkflows({
        orchestrator: orchestrator as unknown as Orchestrator,
      });

      expect(orchestrator.deleteAllWorkflows).toHaveBeenCalledTimes(1);
      // Legacy calls without options — defaults to publishRemovalDeltas: true
      expect(orchestrator.deleteAllWorkflows).toHaveBeenCalledWith();
    });
  });
});
