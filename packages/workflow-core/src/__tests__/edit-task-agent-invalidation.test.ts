
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

describe('agent-mutation invalidation contract', () => {
  it('MUTATION_POLICIES.executionAgent is recreate-class and invalidates active attempts', () => {
    expect(MUTATION_POLICIES.executionAgent.action).toBe('recreateTask');
    expect(MUTATION_POLICIES.executionAgent.invalidatesExecutionSpec).toBe(true);
    expect(MUTATION_POLICIES.executionAgent.invalidateIfActive).toBe(true);
  });

  it('routes through applyInvalidation with cancelInFlight invoked BEFORE recreateTask dep', async () => {
    const deps = makeDeps();
    const policy = MUTATION_POLICIES.executionAgent;

    await applyInvalidation('task', policy.action, 'task-a', deps);

    expect(deps.cancelInFlight).toHaveBeenCalledWith('task', 'task-a');
    expect(deps.recreateTask).toHaveBeenCalledWith('task-a');
    expect(deps.retryTask).not.toHaveBeenCalled();
    expect(deps.retryWorkflow).not.toHaveBeenCalled();
    expect(deps.recreateWorkflow).not.toHaveBeenCalled();
    expect(deps.cancelInFlight.mock.invocationCallOrder[0]).toBeLessThan(
      deps.recreateTask.mock.invocationCallOrder[0],
    );
  });

  it('aborts the recreate when cancelInFlight rejects (stale work must not survive a failed cancel)', async () => {
    const cancelError = new Error('cancel failed');
    const deps = makeDeps({
      cancelInFlight: vi.fn(async () => {
        throw cancelError;
      }),
    });

    await expect(
      applyInvalidation('task', MUTATION_POLICIES.executionAgent.action, 'task-a', deps),
    ).rejects.toBe(cancelError);
    expect(deps.recreateTask).not.toHaveBeenCalled();
  });

  it('idempotence: two consecutive agent edits trigger two cancel-first cycles, ordering preserved', async () => {
    const deps = makeDeps();
    const policy = MUTATION_POLICIES.executionAgent;

    await applyInvalidation('task', policy.action, 'task-a', deps);
    await applyInvalidation('task', policy.action, 'task-a', deps);

    expect(deps.cancelInFlight).toHaveBeenCalledTimes(2);
    expect(deps.recreateTask).toHaveBeenCalledTimes(2);

    // Each cycle: cancelInFlight strictly before its paired recreateTask.
    expect(deps.cancelInFlight.mock.invocationCallOrder[0]).toBeLessThan(
      deps.recreateTask.mock.invocationCallOrder[0],
    );
    expect(deps.cancelInFlight.mock.invocationCallOrder[1]).toBeLessThan(
      deps.recreateTask.mock.invocationCallOrder[1],
    );

    // Cycles are sequential: the first recreate completes before the
    // second cancel begins (await-chain ordering).
    expect(deps.recreateTask.mock.invocationCallOrder[0]).toBeLessThan(
      deps.cancelInFlight.mock.invocationCallOrder[1],
    );
  });

  it('rejects task-scoped wiring with workflow-only actions (defensive scope/action mismatch)', async () => {
    const deps = makeDeps();
    await expect(
      applyInvalidation('workflow', MUTATION_POLICIES.executionAgent.action, 'task-a', deps),
    ).rejects.toThrow(/requires scope 'task'/);
    expect(deps.cancelInFlight).not.toHaveBeenCalled();
    expect(deps.recreateTask).not.toHaveBeenCalled();
  });
});

function stubOrchestrator(overrides: Partial<Orchestrator> = {}): Orchestrator {
  return {
    getTask: vi.fn().mockReturnValue({ config: { workflowId: 'wf-1' } }),
    editTaskAgent: vi.fn().mockReturnValue([] as TaskState[]),
    ...overrides,
  } as unknown as Orchestrator;
}

describe('CommandService.editTaskAgent (headless integration seam)', () => {
  let orchestrator: Orchestrator;
  let service: CommandService;

  beforeEach(() => {
    orchestrator = stubOrchestrator();
    service = new CommandService(orchestrator);
  });

  it('delegates an agent-edit envelope to orchestrator.editTaskAgent with the expected payload', async () => {
    const envelope: CommandEnvelope<{ taskId: string; agentName: string }> = {
      commandId: 'cmd-agent-1',
      source: 'headless',
      scope: 'task',
      idempotencyKey: 'idem-1',
      payload: { taskId: 'wf-1/t1', agentName: 'codex' },
    };

    const result = await service.editTaskAgent(envelope);

    expect(result).toEqual({ ok: true, data: [] });
    expect(orchestrator.editTaskAgent).toHaveBeenCalledWith('wf-1/t1', 'codex');
    expect(orchestrator.editTaskAgent).toHaveBeenCalledTimes(1);
  });

  it('wraps orchestrator errors in CommandResult instead of throwing', async () => {
    orchestrator = stubOrchestrator({
      editTaskAgent: vi.fn().mockImplementation(() => {
        throw new Error('boom');
      }),
    });
    service = new CommandService(orchestrator);

    const envelope: CommandEnvelope<{ taskId: string; agentName: string }> = {
      commandId: 'cmd-agent-2',
      source: 'headless',
      scope: 'task',
      idempotencyKey: 'idem-2',
      payload: { taskId: 'wf-1/t1', agentName: 'doomed' },
    };

    const result = await service.editTaskAgent(envelope);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('EDIT_TASK_AGENT_FAILED');
      expect(result.error.message).toContain('boom');
    }
  });
});
