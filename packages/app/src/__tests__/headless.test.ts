import { afterEach, describe, expect, it, vi } from 'vitest';
import { headlessCheckPrStatus, runHeadless, type HeadlessDeps } from '../headless.js';

function makeTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: 'review_ready',
    description: id,
    dependencies: [],
    createdAt: new Date('2026-08-07T00:00:00Z'),
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: {},
    ...overrides,
  };
}

function makeDeps(tasks = [makeTask('merge-1')]) {
  const checkPrApprovalNow = vi.fn(async () => {});
  const deps = {
    orchestrator: {
      getAllTasks: vi.fn(() => tasks),
      getTask: vi.fn((taskId: string) => tasks.find((task) => task.id === taskId)),
    },
    commandService: {
      runSerializedForWorkflow: vi.fn(async (_workflowId: string | undefined, fn: () => Promise<void>) => {
        await fn();
        return { ok: true as const, data: undefined };
      }),
      runSerializedForTask: vi.fn(async (_taskId: string, fn: () => Promise<void>) => {
        await fn();
        return { ok: true as const, data: undefined };
      }),
    },
    ownerTaskRunnerProvider: vi.fn(() => ({ checkPrApprovalNow })),
  } as unknown as HeadlessDeps;
  return { deps, checkPrApprovalNow };
}

describe('headless check-pr-status', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checks every review-ready or awaiting merge gate through the live owner TaskRunner', async () => {
    const { deps, checkPrApprovalNow } = makeDeps([
      makeTask('merge-review-ready'),
      makeTask('merge-awaiting', { status: 'awaiting_approval' }),
      makeTask('merge-completed', { status: 'completed' }),
      makeTask('regular-review-ready', { config: { workflowId: 'wf-1', isMergeNode: false } }),
    ]);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless(['check-pr-status'], deps);

    expect(deps.ownerTaskRunnerProvider).toHaveBeenCalledTimes(1);
    expect(deps.commandService.runSerializedForWorkflow).toHaveBeenCalledWith(undefined, expect.any(Function));
    expect(checkPrApprovalNow).toHaveBeenCalledTimes(2);
    expect(checkPrApprovalNow).toHaveBeenNthCalledWith(1, 'merge-review-ready');
    expect(checkPrApprovalNow).toHaveBeenNthCalledWith(2, 'merge-awaiting');
    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('Checked PR status for task: merge-review-ready');
    expect(output).toContain('Checked PR status for task: merge-awaiting');
    expect(output).not.toContain('merge-completed');
    expect(output).not.toContain('regular-review-ready');
  });

  it('checks only the requested taskId', async () => {
    const { deps, checkPrApprovalNow } = makeDeps([
      makeTask('merge-1'),
      makeTask('merge-2', { status: 'awaiting_approval' }),
    ]);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await headlessCheckPrStatus('merge-2', deps);

    expect(deps.commandService.runSerializedForTask).toHaveBeenCalledWith('merge-2', expect.any(Function));
    expect(deps.commandService.runSerializedForWorkflow).not.toHaveBeenCalled();
    expect(checkPrApprovalNow).toHaveBeenCalledTimes(1);
    expect(checkPrApprovalNow).toHaveBeenCalledWith('merge-2');
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toBe(
      'Checked PR status for task: merge-2\n',
    );
  });

  it('documents check-pr-status in help output', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless(['--help'], {} as HeadlessDeps);

    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
      'check-pr-status [taskId]',
    );
  });
});
