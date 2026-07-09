import { describe, it, expect, vi } from 'vitest';
import {
  answerOwnerHeadlessQuery,
  type OwnerReadQueryHandlers,
} from '../owner-read-query.js';
import { type HeadlessQueryDeps } from '../headless-query-list.js';

function makeHandlers(over: Partial<OwnerReadQueryHandlers> = {}): OwnerReadQueryHandlers {
  return {
    ownerModeLabel: 'standalone',
    onActivity: vi.fn(),
    getUiPerfStats: vi.fn(() => ({})),
    resetUiPerfStats: vi.fn(),
    getQueueStatus: vi.fn(() => ({ runningCount: 3 })),
    listWorkerActionHistory: vi.fn((request) => ({ workerKind: request.workerKind, actions: [], limit: request.limit ?? 20, offset: request.offset ?? 0, hasMore: false })),
    listWorkerDecisions: vi.fn((request) => ({ decision: request.decision, actions: [], limit: request.limit ?? 20, offset: request.offset ?? 0, hasMore: false })),
    getWorkerStatus: vi.fn(() => ({ generatedAt: 'now', workers: [] })),
    getWorkflowStatus: vi.fn(() => ({})),
    getTasksSnapshot: vi.fn(() => ({ tasks: [], workflows: [] })),
    getActionGraphSnapshot: vi.fn(() => ({ nodes: [] })),
    listWorkflows: vi.fn(() => []),
    loadWorkflowBundle: vi.fn(() => ({ workflow: null, tasks: [] })),
    getReviewGate: vi.fn(() => null),
    getEvents: vi.fn(() => []),
    getTaskById: vi.fn(() => null),
    getTaskOutput: vi.fn(() => ''),
    getOutputChunks: vi.fn(() => []),
    getOutputTail: vi.fn(() => null),
    replayOutput: vi.fn(() => []),
    getAllCompletedTasks: vi.fn(() => []),
    getHistoryTasks: vi.fn(() => []),
    ...over,
  };
}

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

describe('answerOwnerHeadlessQuery', () => {
  it('runs a cli-query on the owner and returns the rendered output', async () => {
    const handlers = makeHandlers();
    const deps = makeQueryDeps(() => [{ id: 'wf-1' }]);
    const result = await answerOwnerHeadlessQuery(
      { kind: 'cli-query', args: ['query', 'workflows', '--output', 'label'] },
      handlers,
      deps,
    );
    expect(result).toEqual({ output: 'wf-1\n' });
    expect(handlers.onActivity).toHaveBeenCalledTimes(1);
  });

  it('refuses to delegate a mutating command via cli-query', async () => {
    const handlers = makeHandlers();
    const deps = makeQueryDeps(() => []);
    await expect(
      answerOwnerHeadlessQuery({ kind: 'cli-query', args: ['run', 'plan.yaml'] }, handlers, deps),
    ).rejects.toThrow(/non-read-only command/);
  });

  it('falls through to the structured dispatcher for non cli-query kinds', async () => {
    const handlers = makeHandlers();
    const deps = makeQueryDeps(() => []);
    const result = await answerOwnerHeadlessQuery({ kind: 'queue' }, handlers, deps);
    expect(result).toEqual({ runningCount: 3 });
    expect(handlers.getQueueStatus).toHaveBeenCalledTimes(1);
  });
});
