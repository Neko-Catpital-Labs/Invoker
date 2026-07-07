import { describe, expect, it } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import {
  runReadOnlyHeadlessQueryToString,
  type HeadlessQueryDeps,
} from '../headless-query-list.js';

const workerActions: WorkerActionRecord[] = [
  {
    id: 'wa-1',
    workerKind: 'autofix',
    actionType: 'fix-task',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-1',
    subjectType: 'task',
    subjectId: 'wf-1/task-1',
    externalKey: 'wf-1/task-1:g0:a1',
    status: 'completed',
    attemptCount: 2,
    intentId: '42',
    agentName: 'codex',
    executionModel: 'gpt-5.2',
    sessionId: 'sess-1',
    summary: 'Fixed failing tests',
    payload: { result: 'ok' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:05:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
  },
];

function makeQueryDeps(): HeadlessQueryDeps {
  return {
    persistence: {
      listWorkerActions: (filters?: unknown) => {
        if (filters && (filters as { workflowId?: string }).workflowId === 'missing') return [];
        return workerActions;
      },
      listWorkflows: () => [],
    } as unknown as HeadlessQueryDeps['persistence'],
    orchestrator: {} as unknown as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as unknown as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
  };
}

describe('headless query worker-actions', () => {
  it('renders worker actions as JSON', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'worker-actions', '--workflow', 'wf-1', '--output', 'json'],
      makeQueryDeps(),
    );

    expect(JSON.parse(output)).toEqual([{
      id: 'wa-1',
      workerKind: 'autofix',
      actionType: 'fix-task',
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      subjectType: 'task',
      subjectId: 'wf-1/task-1',
      externalKey: 'wf-1/task-1:g0:a1',
      status: 'completed',
      attemptCount: 2,
      intentId: '42',
      agentName: 'codex',
      executionModel: 'gpt-5.2',
      sessionId: 'sess-1',
      summary: 'Fixed failing tests',
      payload: { result: 'ok' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:05:00.000Z',
      completedAt: '2026-01-01T00:05:00.000Z',
    }]);
  });

  it('renders worker actions as text and handles an empty result', async () => {
    const text = await runReadOnlyHeadlessQueryToString(
      ['query', 'worker-actions'],
      makeQueryDeps(),
    );
    expect(text).toContain('Worker actions (1)');
    expect(text).toContain('wa-1');
    expect(text).toContain('autofix/fix-task');

    const empty = await runReadOnlyHeadlessQueryToString(
      ['query', 'worker-actions', '--workflow', 'missing'],
      makeQueryDeps(),
    );
    expect(empty).toContain('No worker actions found');
  });
});
