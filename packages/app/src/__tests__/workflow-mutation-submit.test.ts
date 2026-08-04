import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { submitWorkflowMutationOrAcknowledgeDeleted } from '../workflow-mutation-submit.js';
import { PersistedWorkflowMutationCoordinator } from '../persisted-workflow-mutation-coordinator.js';

function makeForeignKeyError(): Error {
  const error = new Error('FOREIGN KEY constraint failed') as Error & { errcode?: number; errstr?: string };
  error.errcode = 787;
  error.errstr = 'constraint failed';
  return error;
}

describe('submitWorkflowMutationOrAcknowledgeDeleted', () => {
  it('treats delete-workflow for an already deleted workflow as accepted without queueing', () => {
    const submit = vi.fn(() => 42);

    const result = submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-deleted',
      'high',
      'invoker:delete-workflow',
      ['wf-deleted'],
      {
        coordinator: { submit },
        workflowExists: () => false,
      },
    );

    expect(result).toEqual({
      ok: true,
      accepted: true,
      intentId: 0,
      workflowId: 'wf-deleted',
      channel: 'invoker:delete-workflow',
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('treats headless delete-workflow for an already deleted workflow as accepted without queueing', () => {
    const submit = vi.fn(() => 42);

    const result = submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-deleted',
      'high',
      'headless.exec',
      [{ args: ['delete-workflow', 'wf-deleted'] }],
      {
        coordinator: { submit },
        workflowExists: () => false,
      },
    );

    expect(result.intentId).toBe(0);
    expect(result.accepted).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it('treats a delete-workflow foreign-key race as already accepted when the workflow is gone', () => {
    const submit = vi.fn(() => {
      throw makeForeignKeyError();
    });
    let exists = true;

    const result = submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-raced',
      'high',
      'invoker:delete-workflow',
      ['wf-raced'],
      {
        coordinator: { submit },
        workflowExists: () => {
          const current = exists;
          exists = false;
          return current;
        },
      },
    );

    expect(result.intentId).toBe(0);
    expect(result.accepted).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('does not treat generic SQLite constraint errors as deleted workflow races', () => {
    const error = new Error('constraint failed') as Error & { errstr?: string };
    error.errstr = 'constraint failed';
    const submit = vi.fn(() => {
      throw error;
    });
    let exists = true;

    expect(() => submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-raced',
      'high',
      'invoker:delete-workflow',
      ['wf-raced'],
      {
        coordinator: { submit },
        workflowExists: () => {
          const current = exists;
          exists = false;
          return current;
        },
      },
    )).toThrow(error);
  });


  it('fixed: headless retry for a missing workflow is accepted without queueing', () => {
    const submit = vi.fn(() => 42);

    const result = submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-missing',
      'high',
      'headless.exec',
      [{ args: ['retry', 'wf-missing'] }],
      {
        coordinator: { submit },
        workflowExists: () => false,
      },
    );

    expect(result.intentId).toBe(0);
    expect(result.accepted).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it('fixed: headless recreate FK race is accepted when the workflow is gone', () => {
    const submit = vi.fn(() => {
      throw makeForeignKeyError();
    });
    let exists = true;

    const result = submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-missing',
      'high',
      'headless.exec',
      [{ args: ['recreate', 'wf-missing'] }],
      {
        coordinator: { submit },
        workflowExists: () => {
          const current = exists;
          exists = false;
          return current;
        },
      },
    );

    expect(result.intentId).toBe(0);
    expect(result.accepted).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('headless recreate-task for a missing workflow is accepted without queueing', () => {
    const submit = vi.fn(() => 42);

    const result = submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-missing',
      'high',
      'headless.exec',
      [{ args: ['recreate-task', 'wf-missing/task-a'] }],
      {
        coordinator: { submit },
        workflowExists: () => false,
      },
    );

    expect(result.intentId).toBe(0);
    expect(result.accepted).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it('headless recreate-task foreign-key race is accepted when the workflow is gone', () => {
    const submit = vi.fn(() => {
      throw makeForeignKeyError();
    });
    let exists = true;

    const result = submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-missing',
      'high',
      'headless.exec',
      [{ args: ['recreate-task', 'wf-missing/task-a'] }],
      {
        coordinator: { submit },
        workflowExists: () => {
          const current = exists;
          exists = false;
          return current;
        },
      },
    );

    expect(result.intentId).toBe(0);
    expect(result.accepted).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('does not treat task targets scoped to another workflow as deleted workflow races', () => {
    const error = makeForeignKeyError();
    const submit = vi.fn(() => {
      throw error;
    });

    expect(() => submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-raced',
      'high',
      'headless.exec',
      [{ args: ['recreate-task', 'wf-other/task-a'] }],
      {
        coordinator: { submit },
        workflowExists: () => false,
      },
    )).toThrow(error);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('does not treat workflow-scoped headless commands with task-like targets as deleted workflow races', () => {
    const error = makeForeignKeyError();
    const submit = vi.fn(() => {
      throw error;
    });

    expect(() => submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-raced',
      'high',
      'headless.exec',
      [{ args: ['recreate', 'wf-raced/task-a'] }],
      {
        coordinator: { submit },
        workflowExists: () => false,
      },
    )).toThrow(error);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('fixed: invoker retry-workflow for a missing workflow is accepted without queueing', () => {
    const submit = vi.fn(() => 42);

    const result = submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-missing',
      'high',
      'invoker:retry-workflow',
      ['wf-missing'],
      {
        coordinator: { submit },
        workflowExists: () => false,
      },
    );

    expect(result.intentId).toBe(0);
    expect(result.accepted).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it('still propagates foreign-key failures for non-idempotent mutations', () => {
    const error = makeForeignKeyError();
    const submit = vi.fn(() => {
      throw error;
    });

    expect(() => submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-missing',
      'high',
      'invoker:fix-with-agent',
      ['wf-missing/task', 'codex'],
      {
        coordinator: { submit },
        workflowExists: () => false,
      },
    )).toThrow(error);
  });

  it('fixed: invoker:start-ready for a workflow deleted concurrently is accepted without queueing', () => {
    const submit = vi.fn(() => 42);

    const result = submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-resumed',
      'normal',
      'invoker:start-ready',
      [{}],
      {
        coordinator: { submit },
        workflowExists: () => false,
      },
    );

    expect(result).toEqual({
      ok: true,
      accepted: true,
      intentId: 0,
      workflowId: 'wf-resumed',
      channel: 'invoker:start-ready',
    });
    expect(submit).not.toHaveBeenCalled();
  });

  describe('workflow-resume wake tick vs. concurrent deleteWorkflow (repro)', () => {
    const adapters: SQLiteAdapter[] = [];

    afterEach(() => {
      for (const adapter of adapters.splice(0)) {
        adapter.close();
      }
    });

    it('fixed: an internal-worker start-ready submit racing a real deleteWorkflow is a benign no-op', async () => {
      const adapter = await SQLiteAdapter.create(':memory:');
      adapters.push(adapter);
      adapter.saveWorkflow({
        id: 'wf-race',
        name: 'wf-race',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const coordinator = new PersistedWorkflowMutationCoordinator(
        adapter,
        'owner-1',
        async () => undefined,
      );

      adapter.deleteWorkflow('wf-race');

      let result: unknown;
      expect(() => {
        result = submitWorkflowMutationOrAcknowledgeDeleted(
          'wf-race',
          'normal',
          'invoker:start-ready',
          [{}],
          {
            coordinator,
            workflowExists: (id) => Boolean(adapter.loadWorkflow(id)),
          },
        );
      }).not.toThrow();

      expect(result).toEqual({
        ok: true,
        accepted: true,
        intentId: 0,
        workflowId: 'wf-race',
        channel: 'invoker:start-ready',
      });
      expect(adapter.listWorkflowMutationIntents('wf-race')).toHaveLength(0);
    });

    it('repro: calling the coordinator directly (bypassing the helper) still throws the raw foreign-key error', async () => {
      const adapter = await SQLiteAdapter.create(':memory:');
      adapters.push(adapter);
      adapter.saveWorkflow({
        id: 'wf-race-2',
        name: 'wf-race-2',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      adapter.deleteWorkflow('wf-race-2');

      expect(() => adapter.enqueueWorkflowMutationIntent('wf-race-2', 'invoker:start-ready', [{}], 'normal'))
        .toThrow(/FOREIGN KEY constraint failed/);
    });
  });
});
