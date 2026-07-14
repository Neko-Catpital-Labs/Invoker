import { describe, it, expect, vi } from 'vitest';
import {
  runReadOnlyHeadlessQueryToString,
  type HeadlessQueryDeps,
} from '../headless-query-list.js';

function makeQueryDeps(listWorkflows: () => Array<{ id: string; status?: string }>): HeadlessQueryDeps {
  return {
    persistence: { listWorkflows } as unknown as HeadlessQueryDeps['persistence'],
    orchestrator: {} as unknown as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as unknown as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
  };
}

describe('runReadOnlyHeadlessQueryToString', () => {
  it('captures rendered output instead of writing to process.stdout', async () => {
    const deps = makeQueryDeps(() => [{ id: 'wf-1' }, { id: 'wf-2' }]);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const output = await runReadOnlyHeadlessQueryToString(
        ['query', 'workflows', '--output', 'label'],
        deps,
      );
      expect(output).toBe('wf-1\nwf-2\n');
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('captures review-gate output instead of writing to process.stdout', async () => {
    const deps = makeQueryDeps(() => []);
    deps.persistence = {
      ...deps.persistence,
      findReviewGateByPr: () => ({
        workflowId: 'wf-review',
        reviewId: 123,
        workflowStatus: 'running',
        workflowGeneration: 7,
        branch: 'stack/review',
      }),
    } as unknown as HeadlessQueryDeps['persistence'];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const output = await runReadOnlyHeadlessQueryToString(
        ['query', 'review-gate', '123', '--output', 'label'],
        deps,
      );
      expect(output).toBe('wf-review\n');
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('maps the deprecated alias `list` to `query workflows`', async () => {
    const deps = makeQueryDeps(() => [{ id: 'wf-9' }]);
    const output = await runReadOnlyHeadlessQueryToString(['list', '--output', 'label'], deps);
    expect(output).toBe('wf-9\n');
  });

  it('uses configured default agent when session task has no persisted agent name', async () => {
    const task = {
      id: 'wf-1/task-1',
      status: 'failed',
      description: 'failed',
      dependencies: [],
      createdAt: new Date(),
      config: { workflowId: 'wf-1', runnerKind: 'local' },
      execution: { agentSessionId: 'sess-1' },
    };
    const deps = makeQueryDeps(() => [{ id: 'wf-1' }]);
    deps.invokerConfig = { defaultExecutionAgent: 'custom-agent' } as unknown as HeadlessQueryDeps['invokerConfig'];
    deps.persistence = {
      ...deps.persistence,
      loadTasks: vi.fn(() => [task]),
      getEvents: vi.fn(() => []),
    } as unknown as HeadlessQueryDeps['persistence'];
    deps.orchestrator = {
      syncFromDb: vi.fn(),
      getTask: vi.fn(() => task),
      getAllTasks: vi.fn(() => [task]),
    } as unknown as HeadlessQueryDeps['orchestrator'];

    const output = await runReadOnlyHeadlessQueryToString(['session', 'task-1'], deps);

    expect(output).toContain('agent=custom-agent sessionId=sess-1\n');
  });

  it('rejects a command that is not a delegatable read-only query', async () => {
    const deps = makeQueryDeps(() => []);
    await expect(runReadOnlyHeadlessQueryToString(['watch', 'wf-1'], deps)).rejects.toThrow(
      /not a delegatable read-only query/,
    );
  });

  it('rejects `query ui-perf --reset` so delegation cannot clear owner stats', async () => {
    const resetUiPerfStats = vi.fn();
    const deps = { ...makeQueryDeps(() => []), resetUiPerfStats, getUiPerfStats: () => ({}) };
    await expect(
      runReadOnlyHeadlessQueryToString(['query', 'ui-perf', '--reset'], deps),
    ).rejects.toThrow(/read-only/);
    expect(resetUiPerfStats).not.toHaveBeenCalled();
  });

  it('still allows non-destructive `query ui-perf`', async () => {
    const resetUiPerfStats = vi.fn();
    const deps = { ...makeQueryDeps(() => []), resetUiPerfStats, getUiPerfStats: () => ({ mainDeltaToUi: 1 }) };
    await expect(runReadOnlyHeadlessQueryToString(['query', 'ui-perf'], deps)).resolves.toContain('mainDeltaToUi');
    expect(resetUiPerfStats).not.toHaveBeenCalled();
  });

  it('answers a delegated `worker status` query on the writable owner', async () => {
    const deps = makeQueryDeps(() => []);
    deps.persistence = {
      listWorkflows: () => [],
      loadTasks: () => [],
      getEvents: () => [],
      listWorkerActions: () => [{
        id: 'wa-worker-status',
        workerKind: 'autofix',
        actionType: 'fix-task',
        workflowId: 'wf-1',
        taskId: 'wf-1/task-1',
        subjectType: 'task',
        subjectId: 'wf-1/task-1',
        externalKey: 'wf-1/task-1:g0:a1',
        status: 'completed',
        attemptCount: 1,
        summary: 'Fixed failing tests',
        payload: { reason: 'ci-failure' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
        completedAt: '2026-01-01T00:01:00.000Z',
      }],
    } as unknown as HeadlessQueryDeps['persistence'];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const label = await runReadOnlyHeadlessQueryToString(['worker', 'status', '--output', 'label'], deps);
      expect(label).toBe('auto-fix-recovery\n');
      const json = await runReadOnlyHeadlessQueryToString(['worker', 'status', '--output', 'json'], deps);
      const parsed = JSON.parse(json) as { workerId?: string; recentActions?: Array<{ id?: string; reason?: string }> };
      expect(parsed.workerId).toBe('auto-fix-recovery');
      expect(parsed.recentActions).toEqual([
        expect.objectContaining({ id: 'wa-worker-status', reason: 'ci-failure' }),
      ]);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('rejects a mutating `worker autofix` scan as non-delegatable', async () => {
    const deps = makeQueryDeps(() => []);
    await expect(
      runReadOnlyHeadlessQueryToString(['worker', 'autofix'], deps),
    ).rejects.toThrow(/worker autofix is not a delegatable read-only query/);
  });
});
