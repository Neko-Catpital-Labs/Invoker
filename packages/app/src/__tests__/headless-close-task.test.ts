import { describe, it, expect, vi } from 'vitest';
import { headlessCloseTask } from '../headless-approve-delete.js';

function makeDeps(overrides: { closeIdleTaskResult: { ok: true; data: unknown } | { ok: false; error: { message: string } } }) {
  const workflows = [{ id: 'wf-1' }];
  const tasks = [{ id: 'wf-1/task-a' }];
  return {
    orchestrator: {
      syncFromDb: vi.fn(),
    } as any,
    persistence: {
      listWorkflows: vi.fn(() => workflows),
      loadTasks: vi.fn(() => tasks),
    } as any,
    commandService: {
      closeIdleTask: vi.fn(async () => overrides.closeIdleTaskResult),
    } as any,
  };
}

describe('headlessCloseTask', () => {
  it('closes a task via commandService.closeIdleTask and reports success', async () => {
    const deps = makeDeps({ closeIdleTaskResult: { ok: true, data: { id: 'wf-1/task-a', status: 'closed' } } });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await headlessCloseTask('wf-1/task-a', deps);

    expect(deps.commandService.closeIdleTask).toHaveBeenCalledTimes(1);
    const [envelope] = deps.commandService.closeIdleTask.mock.calls[0];
    expect(envelope.payload.taskId).toBe('wf-1/task-a');
    expect(write.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('Closed task: wf-1/task-a');
    write.mockRestore();
  });

  it('propagates a TASK_NOT_CLOSABLE-style command failure', async () => {
    const deps = makeDeps({
      closeIdleTaskResult: { ok: false, error: { message: 'Task "wf-1/task-a" is "pending"; only failed, completed, or review_ready tasks can be closed' } },
    });

    await expect(headlessCloseTask('wf-1/task-a', deps)).rejects.toThrow('only failed, completed, or review_ready');
  });

  it('throws when taskId is missing', async () => {
    const deps = makeDeps({ closeIdleTaskResult: { ok: true, data: {} } });
    await expect(headlessCloseTask('', deps)).rejects.toThrow('Missing taskId');
  });
});
