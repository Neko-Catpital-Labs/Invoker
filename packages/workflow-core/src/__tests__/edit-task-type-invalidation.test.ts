
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyInvalidation,
  MUTATION_POLICIES,
  type InvalidationDeps,
} from '../invalidation-policy.js';
import { CommandService } from '../command-service.js';
import type { Orchestrator } from '../orchestrator.js';
import type { CommandEnvelope } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-graph';

type MockedDeps = InvalidationDeps & {
  cancelInFlight: ReturnType<typeof vi.fn>;
  retryTask: ReturnType<typeof vi.fn>;
  recreateTask: ReturnType<typeof vi.fn>;
  retryWorkflow: ReturnType<typeof vi.fn>;
  recreateWorkflow: ReturnType<typeof vi.fn>;
};

function makeDeps(overrides: Partial<MockedDeps> = {}): MockedDeps {
  return {
    cancelInFlight: vi.fn(async () => undefined),
    retryTask: vi.fn(async () => []),
    recreateTask: vi.fn(async () => []),
    retryWorkflow: vi.fn(async () => []),
    recreateWorkflow: vi.fn(async () => []),
    ...overrides,
  } as MockedDeps;
}

describe('executor-type-mutation invalidation contract', () => {
  it('MUTATION_POLICIES.executorType is RETRY-class (not recreate) and invalidates active attempts', () => {
    expect(MUTATION_POLICIES.executorType.action).toBe('retryTask');
    expect(MUTATION_POLICIES.executorType.invalidatesExecutionSpec).toBe(true);
    expect(MUTATION_POLICIES.executorType.invalidateIfActive).toBe(true);

    // Defensive: make sure executor-type didn't accidentally land in the
    // same recreate-class bucket as command/prompt/executionAgent. The
    // chart preserves workspace lineage for substrate-only changes, so
    // the action MUST be `retryTask`, not `recreateTask`.
    expect(MUTATION_POLICIES.executorType.action).not.toBe('recreateTask');
  });

  it('routes through applyInvalidation with cancelInFlight invoked BEFORE retryTask dep', async () => {
    const deps = makeDeps();
    const policy = MUTATION_POLICIES.executorType;

    await applyInvalidation('task', policy.action, 'task-a', deps);

    expect(deps.cancelInFlight).toHaveBeenCalledWith('task', 'task-a');
    expect(deps.retryTask).toHaveBeenCalledWith('task-a');
    // Recreate-class deps MUST NOT be on the path — that would discard
    // branch/workspacePath the chart says is still authoritative.
    expect(deps.recreateTask).not.toHaveBeenCalled();
    expect(deps.retryWorkflow).not.toHaveBeenCalled();
    expect(deps.recreateWorkflow).not.toHaveBeenCalled();
    expect(deps.cancelInFlight.mock.invocationCallOrder[0]).toBeLessThan(
      deps.retryTask.mock.invocationCallOrder[0],
    );
  });

  it('aborts the retry when cancelInFlight rejects (stale work must not survive a failed cancel)', async () => {
    const cancelError = new Error('cancel failed');
    const deps = makeDeps({
      cancelInFlight: vi.fn(async () => {
        throw cancelError;
      }),
    });

    await expect(
      applyInvalidation('task', MUTATION_POLICIES.executorType.action, 'task-a', deps),
    ).rejects.toBe(cancelError);
    expect(deps.retryTask).not.toHaveBeenCalled();
  });

  it('idempotence: two consecutive executor-type edits trigger two cancel-first cycles, ordering preserved', async () => {
    const deps = makeDeps();
    const policy = MUTATION_POLICIES.executorType;

    await applyInvalidation('task', policy.action, 'task-a', deps);
    await applyInvalidation('task', policy.action, 'task-a', deps);

    expect(deps.cancelInFlight).toHaveBeenCalledTimes(2);
    expect(deps.retryTask).toHaveBeenCalledTimes(2);

    // Each cycle: cancelInFlight strictly before its paired retryTask.
    expect(deps.cancelInFlight.mock.invocationCallOrder[0]).toBeLessThan(
      deps.retryTask.mock.invocationCallOrder[0],
    );
    expect(deps.cancelInFlight.mock.invocationCallOrder[1]).toBeLessThan(
      deps.retryTask.mock.invocationCallOrder[1],
    );

    // Cycles are sequential: the first retry completes before the
    // second cancel begins (await-chain ordering).
    expect(deps.retryTask.mock.invocationCallOrder[0]).toBeLessThan(
      deps.cancelInFlight.mock.invocationCallOrder[1],
    );
  });

  it('rejects task-scoped wiring with workflow-only actions (defensive scope/action mismatch)', async () => {
    const deps = makeDeps();
    await expect(
      applyInvalidation('workflow', MUTATION_POLICIES.executorType.action, 'task-a', deps),
    ).rejects.toThrow(/requires scope 'task'/);
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
    expect(deps.retryTask).not.toHaveBeenCalled();
  });
});

function stubOrchestrator(overrides: Partial<Orchestrator> = {}): Orchestrator {
  return {
    getTask: vi.fn().mockReturnValue({ config: { workflowId: 'wf-1' } }),
    editTaskType: vi.fn().mockReturnValue([] as TaskState[]),
    ...overrides,
  } as unknown as Orchestrator;
}

describe('CommandService.editTaskType (headless integration seam)', () => {
  let orchestrator: Orchestrator;
  let service: CommandService;

  beforeEach(() => {
    orchestrator = stubOrchestrator();
    service = new CommandService(orchestrator);
  });

  it('delegates an executor-type-edit envelope to orchestrator.editTaskType with the expected payload', async () => {
    const envelope: CommandEnvelope<{ taskId: string; executorType: string; remoteTargetId?: string }> = {
      commandId: 'cmd-type-1',
      source: 'headless',
      scope: 'task',
      idempotencyKey: 'idem-1',
      payload: { taskId: 'wf-1/t1', executorType: 'worktree' },
    };

    const result = await service.editTaskType(envelope);

    expect(result).toEqual({ ok: true, data: [] });
    expect(orchestrator.editTaskType).toHaveBeenCalledWith('wf-1/t1', 'worktree', undefined);
    expect(orchestrator.editTaskType).toHaveBeenCalledTimes(1);
  });

  it('forwards remoteTargetId for the SSH substrate', async () => {
    const envelope: CommandEnvelope<{ taskId: string; executorType: string; remoteTargetId?: string }> = {
      commandId: 'cmd-type-ssh',
      source: 'headless',
      scope: 'task',
      idempotencyKey: 'idem-ssh',
      payload: { taskId: 'wf-1/t1', executorType: 'ssh', remoteTargetId: 'remote_digital_ocean' },
    };

    const result = await service.editTaskType(envelope);

    expect(result).toEqual({ ok: true, data: [] });
    expect(orchestrator.editTaskType).toHaveBeenCalledWith(
      'wf-1/t1',
      'ssh',
      'remote_digital_ocean',
    );
  });

  it('wraps orchestrator errors in CommandResult instead of throwing', async () => {
    orchestrator = stubOrchestrator({
      editTaskType: vi.fn().mockImplementation(() => {
        throw new Error('boom');
      }),
    });
    service = new CommandService(orchestrator);

    const envelope: CommandEnvelope<{ taskId: string; executorType: string; remoteTargetId?: string }> = {
      commandId: 'cmd-type-err',
      source: 'headless',
      scope: 'task',
      idempotencyKey: 'idem-err',
      payload: { taskId: 'wf-1/t1', executorType: 'doomed' },
    };

    const result = await service.editTaskType(envelope);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('EDIT_TASK_TYPE_FAILED');
      expect(result.error.message).toContain('boom');
    }
  });
});
