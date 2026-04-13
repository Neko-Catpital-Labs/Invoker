import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandService } from '../command-service.js';
import type { CommandEnvelope } from '@invoker/contracts';
import type { Orchestrator } from '../orchestrator.js';
import type { TaskState } from '@invoker/workflow-graph';

// ── Helpers ─────────────────────────────────────────────────

function makeEnvelope<P>(
  payload: P,
  idempotencyKey = 'key-1',
): CommandEnvelope<P> {
  return {
    commandId: 'cmd-1',
    source: 'headless',
    scope: 'task',
    idempotencyKey,
    payload,
  };
}

function stubOrchestrator(overrides: Partial<Orchestrator> = {}): Orchestrator {
  return {
    approve: vi.fn().mockResolvedValue([] as TaskState[]),
    reject: vi.fn(),
    getTask: vi.fn().mockReturnValue(undefined),
    revertConflictResolution: vi.fn(),
    provideInput: vi.fn(),
    restartTask: vi.fn().mockReturnValue([]),
    selectExperiment: vi.fn().mockReturnValue([]),
    editTaskCommand: vi.fn().mockReturnValue([]),
    editTaskType: vi.fn().mockReturnValue([]),
    editTaskAgent: vi.fn().mockReturnValue([]),
    setTaskExternalGatePolicies: vi.fn().mockReturnValue([]),
    replaceTask: vi.fn().mockReturnValue([]),
    cancelTask: vi.fn().mockReturnValue({ cancelled: [], runningCancelled: [] }),
    cancelWorkflow: vi.fn().mockReturnValue({ cancelled: [], runningCancelled: [] }),
    deleteWorkflow: vi.fn(),
    retryWorkflow: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as Orchestrator;
}

// ── Tests ───────────────────────────────────────────────────

describe('CommandService', () => {
  let orchestrator: Orchestrator;
  let service: CommandService;

  beforeEach(() => {
    orchestrator = stubOrchestrator();
    service = new CommandService(orchestrator);
  });

  // ── approve ─────────────────────────────────────────────

  describe('approve', () => {
    it('delegates to orchestrator.approve', async () => {
      const envelope = makeEnvelope({ taskId: 't-1' });
      const result = await service.approve(envelope);

      expect(result).toEqual({ ok: true, data: [] });
      expect(orchestrator.approve).toHaveBeenCalledWith('t-1');
      expect(orchestrator.approve).toHaveBeenCalledTimes(1);
    });

    it('calls orchestrator on each invocation', async () => {
      await service.approve(makeEnvelope({ taskId: 't-1' }, 'key-a'));
      await service.approve(makeEnvelope({ taskId: 't-2' }, 'key-b'));

      expect(orchestrator.approve).toHaveBeenCalledTimes(2);
    });

    it('wraps orchestrator errors in CommandResult', async () => {
      orchestrator = stubOrchestrator({
        approve: vi.fn().mockRejectedValue(new Error('boom')),
      });
      service = new CommandService(orchestrator);

      const result = await service.approve(makeEnvelope({ taskId: 't-1' }));

      expect(result).toEqual({
        ok: false,
        error: { code: 'APPROVE_FAILED', message: 'boom' },
      });
    });
  });

  // ── reject ──────────────────────────────────────────────

  describe('reject', () => {
    it('delegates to orchestrator.reject when no pendingFixError', async () => {
      const envelope = makeEnvelope({ taskId: 't-1', reason: 'bad' });
      const result = await service.reject(envelope);

      expect(result).toEqual({ ok: true, data: undefined });
      expect(orchestrator.reject).toHaveBeenCalledWith('t-1', 'bad');
      expect(orchestrator.revertConflictResolution).not.toHaveBeenCalled();
    });

    it('calls revertConflictResolution when pendingFixError exists', async () => {
      (orchestrator.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
        execution: { pendingFixError: 'merge conflict' },
      });
      const envelope = makeEnvelope({ taskId: 't-1', reason: 'bad' });
      const result = await service.reject(envelope);

      expect(result).toEqual({ ok: true, data: undefined });
      expect(orchestrator.revertConflictResolution).toHaveBeenCalledWith(
        't-1',
        'merge conflict',
      );
      expect(orchestrator.reject).not.toHaveBeenCalled();
    });
  });

  // ── provideInput ─────────────────────────────────────────

  describe('provideInput', () => {
    it('delegates to orchestrator.provideInput', async () => {
      const envelope = makeEnvelope({ taskId: 't-1', input: 'hello' });
      const result = await service.provideInput(envelope);

      expect(result).toEqual({ ok: true, data: undefined });
      expect(orchestrator.provideInput).toHaveBeenCalledWith('t-1', 'hello');
    });

    it('returns error on exception', async () => {
      (orchestrator.provideInput as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('task not found');
      });
      const result = await service.provideInput(makeEnvelope({ taskId: 'bad', input: 'x' }));
      expect(result).toEqual({ ok: false, error: { code: 'PROVIDE_INPUT_FAILED', message: 'task not found' } });
    });
  });

  // ── restartTask ──────────────────────────────────────────

  describe('restartTask', () => {
    it('delegates to orchestrator.restartTask', async () => {
      const result = await service.restartTask(makeEnvelope({ taskId: 't-1' }));
      expect(result).toEqual({ ok: true, data: [] });
      expect(orchestrator.restartTask).toHaveBeenCalledWith('t-1');
    });

    it('returns error on exception', async () => {
      (orchestrator.restartTask as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('not failed');
      });
      const result = await service.restartTask(makeEnvelope({ taskId: 't-1' }));
      expect(result).toEqual({ ok: false, error: { code: 'RESTART_TASK_FAILED', message: 'not failed' } });
    });
  });

  // ── selectExperiment ─────────────────────────────────────

  describe('selectExperiment', () => {
    it('delegates to orchestrator.selectExperiment', async () => {
      const result = await service.selectExperiment(makeEnvelope({ taskId: 't-1', experimentId: 'exp-1' }));
      expect(result).toEqual({ ok: true, data: [] });
      expect(orchestrator.selectExperiment).toHaveBeenCalledWith('t-1', 'exp-1');
    });

    it('returns error on exception', async () => {
      (orchestrator.selectExperiment as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('experiment not found');
      });
      const result = await service.selectExperiment(makeEnvelope({ taskId: 't-1', experimentId: 'bad' }));
      expect(result).toEqual({ ok: false, error: { code: 'SELECT_EXPERIMENT_FAILED', message: 'experiment not found' } });
    });
  });

  // ── editTaskCommand ──────────────────────────────────────

  describe('editTaskCommand', () => {
    it('delegates to orchestrator.editTaskCommand', async () => {
      const result = await service.editTaskCommand(makeEnvelope({ taskId: 't-1', newCommand: 'echo hi' }));
      expect(result).toEqual({ ok: true, data: [] });
      expect(orchestrator.editTaskCommand).toHaveBeenCalledWith('t-1', 'echo hi');
    });

    it('returns error on exception', async () => {
      (orchestrator.editTaskCommand as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Cannot edit running task');
      });
      const result = await service.editTaskCommand(makeEnvelope({ taskId: 't-1', newCommand: 'x' }));
      expect(result).toEqual({ ok: false, error: { code: 'EDIT_TASK_COMMAND_FAILED', message: 'Cannot edit running task' } });
    });
  });

  // ── editTaskType ─────────────────────────────────────────

  describe('editTaskType', () => {
    it('delegates to orchestrator.editTaskType', async () => {
      const result = await service.editTaskType(makeEnvelope({ taskId: 't-1', executorType: 'docker' }));
      expect(result).toEqual({ ok: true, data: [] });
      expect(orchestrator.editTaskType).toHaveBeenCalledWith('t-1', 'docker', undefined);
    });

    it('passes remoteTargetId when provided', async () => {
      const result = await service.editTaskType(makeEnvelope({ taskId: 't-1', executorType: 'ssh', remoteTargetId: 'host-1' }));
      expect(result).toEqual({ ok: true, data: [] });
      expect(orchestrator.editTaskType).toHaveBeenCalledWith('t-1', 'ssh', 'host-1');
    });

    it('returns error on exception', async () => {
      (orchestrator.editTaskType as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Cannot edit merge node');
      });
      const result = await service.editTaskType(makeEnvelope({ taskId: 't-1', executorType: 'bad' }));
      expect(result).toEqual({ ok: false, error: { code: 'EDIT_TASK_TYPE_FAILED', message: 'Cannot edit merge node' } });
    });
  });

  // ── editTaskAgent ────────────────────────────────────────

  describe('editTaskAgent', () => {
    it('delegates to orchestrator.editTaskAgent', async () => {
      const result = await service.editTaskAgent(makeEnvelope({ taskId: 't-1', agentName: 'codex' }));
      expect(result).toEqual({ ok: true, data: [] });
      expect(orchestrator.editTaskAgent).toHaveBeenCalledWith('t-1', 'codex');
    });

    it('returns error on exception', async () => {
      (orchestrator.editTaskAgent as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('boom');
      });
      const result = await service.editTaskAgent(makeEnvelope({ taskId: 't-1', agentName: 'x' }));
      expect(result).toEqual({ ok: false, error: { code: 'EDIT_TASK_AGENT_FAILED', message: 'boom' } });
    });
  });

  // ── setTaskExternalGatePolicies ──────────────────────────

  describe('setTaskExternalGatePolicies', () => {
    it('delegates to orchestrator.setTaskExternalGatePolicies', async () => {
      const updates = [{ workflowId: 'wf-1', taskId: '__merge__', gatePolicy: 'review_ready' as const }];
      const result = await service.setTaskExternalGatePolicies(makeEnvelope({ taskId: 't-1', updates }));
      expect(result).toEqual({ ok: true, data: [] });
      expect(orchestrator.setTaskExternalGatePolicies).toHaveBeenCalledWith('t-1', updates);
    });

    it('returns error on exception', async () => {
      (orchestrator.setTaskExternalGatePolicies as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('bad update');
      });
      const result = await service.setTaskExternalGatePolicies(makeEnvelope({ taskId: 't-1', updates: [] }));
      expect(result).toEqual({ ok: false, error: { code: 'SET_GATE_POLICIES_FAILED', message: 'bad update' } });
    });
  });

  // ── replaceTask ──────────────────────────────────────────

  describe('replaceTask', () => {
    it('delegates to orchestrator.replaceTask', async () => {
      const replacementTasks = [{ command: 'echo hi' }] as any;
      const result = await service.replaceTask(makeEnvelope({ taskId: 't-1', replacementTasks }));
      expect(result).toEqual({ ok: true, data: [] });
      expect(orchestrator.replaceTask).toHaveBeenCalledWith('t-1', replacementTasks);
    });

    it('returns error on exception', async () => {
      (orchestrator.replaceTask as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('cannot replace');
      });
      const result = await service.replaceTask(makeEnvelope({ taskId: 't-1', replacementTasks: [] }));
      expect(result).toEqual({ ok: false, error: { code: 'REPLACE_TASK_FAILED', message: 'cannot replace' } });
    });
  });

  // ── cancelTask ───────────────────────────────────────────

  describe('cancelTask', () => {
    it('delegates to orchestrator.cancelTask', async () => {
      const result = await service.cancelTask(makeEnvelope({ taskId: 't-1' }));
      expect(result).toEqual({ ok: true, data: { cancelled: [], runningCancelled: [] } });
      expect(orchestrator.cancelTask).toHaveBeenCalledWith('t-1');
    });

    it('returns error on exception', async () => {
      (orchestrator.cancelTask as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('not found');
      });
      const result = await service.cancelTask(makeEnvelope({ taskId: 'bad' }));
      expect(result).toEqual({ ok: false, error: { code: 'CANCEL_TASK_FAILED', message: 'not found' } });
    });
  });

  // ── cancelWorkflow ───────────────────────────────────────

  describe('cancelWorkflow', () => {
    it('delegates to orchestrator.cancelWorkflow', async () => {
      const envelope = makeEnvelope({ workflowId: 'wf-1' });
      const result = await service.cancelWorkflow(envelope);
      expect(result).toEqual({ ok: true, data: { cancelled: [], runningCancelled: [] } });
      expect(orchestrator.cancelWorkflow).toHaveBeenCalledWith('wf-1');
    });

    it('returns error on exception', async () => {
      (orchestrator.cancelWorkflow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('wf not found');
      });
      const result = await service.cancelWorkflow(makeEnvelope({ workflowId: 'bad' }));
      expect(result).toEqual({ ok: false, error: { code: 'CANCEL_WORKFLOW_FAILED', message: 'wf not found' } });
    });
  });

  // ── deleteWorkflow ───────────────────────────────────────

  describe('deleteWorkflow', () => {
    it('delegates to orchestrator.deleteWorkflow', async () => {
      const result = await service.deleteWorkflow(makeEnvelope({ workflowId: 'wf-1' }));
      expect(result).toEqual({ ok: true, data: undefined });
      expect(orchestrator.deleteWorkflow).toHaveBeenCalledWith('wf-1');
    });

    it('returns error on exception', async () => {
      (orchestrator.deleteWorkflow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('wf not found');
      });
      const result = await service.deleteWorkflow(makeEnvelope({ workflowId: 'bad' }));
      expect(result).toEqual({ ok: false, error: { code: 'DELETE_WORKFLOW_FAILED', message: 'wf not found' } });
    });
  });

  // ── retryWorkflow ────────────────────────────────────────

  describe('retryWorkflow', () => {
    it('delegates to orchestrator.retryWorkflow', async () => {
      const result = await service.retryWorkflow(makeEnvelope({ workflowId: 'wf-1' }));
      expect(result).toEqual({ ok: true, data: [] });
      expect(orchestrator.retryWorkflow).toHaveBeenCalledWith('wf-1');
    });

    it('returns error on exception', async () => {
      (orchestrator.retryWorkflow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('wf not found');
      });
      const result = await service.retryWorkflow(makeEnvelope({ workflowId: 'bad' }));
      expect(result).toEqual({ ok: false, error: { code: 'RETRY_WORKFLOW_FAILED', message: 'wf not found' } });
    });
  });

  // ── Scoped serialization ─────────────────────────────────

  describe('scoped serialization', () => {
    it('serializes concurrent calls for the same workflow so they do not interleave', async () => {
      const order: string[] = [];
      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>(r => { resolveFirst = r; });

      (orchestrator.getTask as ReturnType<typeof vi.fn>).mockImplementation((taskId: string) => ({
        config: { workflowId: taskId === 't-1' ? 'wf-1' : 'wf-1' },
      }));

      (orchestrator.restartTask as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        order.push('restart-start');
        await firstPromise;
        order.push('restart-end');
        return [];
      });
      (orchestrator.editTaskCommand as ReturnType<typeof vi.fn>).mockImplementation(() => {
        order.push('edit-start');
        order.push('edit-end');
        return [];
      });

      const p1 = service.restartTask(makeEnvelope({ taskId: 't-1' }, 'k1'));
      const p2 = service.editTaskCommand(makeEnvelope({ taskId: 't-2', newCommand: 'x' }, 'k2'));

      // Let the first call complete
      resolveFirst();

      await Promise.all([p1, p2]);

      // Restart must fully complete before edit begins
      expect(order).toEqual(['restart-start', 'restart-end', 'edit-start', 'edit-end']);
    });

    it('allows concurrent calls for different workflows', async () => {
      const order: string[] = [];
      let resolveRestart!: () => void;
      let resolveEdit!: () => void;
      const restartGate = new Promise<void>((resolve) => { resolveRestart = resolve; });
      const editGate = new Promise<void>((resolve) => { resolveEdit = resolve; });

      (orchestrator.getTask as ReturnType<typeof vi.fn>).mockImplementation((taskId: string) => ({
        config: { workflowId: taskId === 't-1' ? 'wf-1' : 'wf-2' },
      }));

      (orchestrator.restartTask as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        order.push('restart-start');
        await restartGate;
        order.push('restart-end');
        return [];
      });
      (orchestrator.editTaskCommand as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        order.push('edit-start');
        await editGate;
        order.push('edit-end');
        return [];
      });

      const p1 = service.restartTask(makeEnvelope({ taskId: 't-1' }, 'k1'));
      const p2 = service.editTaskCommand(makeEnvelope({ taskId: 't-2', newCommand: 'x' }, 'k2'));

      await Promise.resolve();
      expect(order).toEqual(['restart-start', 'edit-start']);

      resolveRestart();
      resolveEdit();

      await Promise.all([p1, p2]);
      expect(order).toEqual(['restart-start', 'edit-start', 'restart-end', 'edit-end']);
    });
  });
});
