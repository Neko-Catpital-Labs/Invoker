import { describe, expect, it, vi } from 'vitest';
import { submitWorkflowMutationOrAcknowledgeDeleted } from '../workflow-mutation-submit.js';

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

  it('treats headless recreate-task for an explicitly scoped task in a deleted workflow as accepted without queueing', () => {
    const submit = vi.fn(() => 42);

    const result = submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-deleted',
      'high',
      'headless.exec',
      [{ args: ['recreate-task', 'wf-deleted/verify-ui-visual-snapshots'] }],
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

  it('treats headless retry-task foreign-key races as accepted when the scoped workflow is gone', () => {
    const submit = vi.fn(() => {
      throw makeForeignKeyError();
    });
    let exists = true;

    const result = submitWorkflowMutationOrAcknowledgeDeleted(
      'wf-raced',
      'high',
      'headless.exec',
      [{ args: ['retry-task', 'wf-raced/test-land-stack-guard'] }],
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
      [{ args: ['recreate-task', 'wf-other/test-land-stack-guard'] }],
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
      [{ args: ['recreate', 'wf-raced/test-land-stack-guard'] }],
      {
        coordinator: { submit },
        workflowExists: () => false,
      },
    )).toThrow(error);
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
});
