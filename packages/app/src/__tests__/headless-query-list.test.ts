import { describe, expect, it } from 'vitest';
import type { WorkerActionRecord } from '@invoker/data-store';
import {
  runReadOnlyHeadlessQueryToString,
  type HeadlessQueryDeps,
} from '../headless-query-list.js';
import { AUTO_STARTED_OWNER_WORKER_KINDS } from '../worker-control.js';

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

const decisionActions: WorkerActionRecord[] = [
  {
    id: 'wd-1',
    workerKind: 'autofix',
    actionType: 'fix-task',
    workflowId: 'wf-1',
    subjectType: 'task',
    subjectId: 'wf-1/task-2',
    externalKey: 'wf-1/task-2:g0:a1',
    status: 'skipped',
    attemptCount: 3,
    payload: { reason: 'worker-retry-budget-exhausted' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:02:00.000Z',
  },
];

function makeDecisionDeps(): HeadlessQueryDeps {
  return {
    persistence: {
      listWorkerActions: () => decisionActions,
      listWorkflows: () => [],
    } as unknown as HeadlessQueryDeps['persistence'],
    orchestrator: {} as unknown as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as unknown as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
  };
}

describe('headless query worker-decisions', () => {
  it('surfaces decision class and reason as JSON', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'worker-decisions', '--workflow', 'wf-1', '--decision', 'skip', '--output', 'json'],
      makeDecisionDeps(),
    );

    const parsed = JSON.parse(output) as Array<{ decision?: string; reason?: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].decision).toBe('skip');
    expect(parsed[0].reason).toBe('worker-retry-budget-exhausted');
  });

  it('rejects an invalid --decision value', async () => {
    await expect(
      runReadOnlyHeadlessQueryToString(
        ['query', 'worker-decisions', '--decision', 'bogus'],
        makeDecisionDeps(),
      ),
    ).rejects.toThrow('Invalid --decision');
  });
});

function makeWorkersDeps(): HeadlessQueryDeps {
  return {
    persistence: {
      // Snapshot construction reads recent actions per worker and walks
      // workflow events for the auto-fix recovery summary; empty results keep
      // the fleet shape deterministic.
      listWorkerActions: () => [],
      listWorkflows: () => [],
      loadTasks: () => [],
      getEvents: () => [],
    } as unknown as HeadlessQueryDeps['persistence'],
    orchestrator: {} as unknown as HeadlessQueryDeps['orchestrator'],
    executionAgentRegistry: undefined,
    invokerConfig: {} as unknown as HeadlessQueryDeps['invokerConfig'],
    getUiPerfStats: () => ({}),
    resetUiPerfStats: () => {},
  };
}

type WorkerSnapshotEntry = {
  kind: string;
  lifecycle: string;
  policy: string;
  autoStarts: boolean;
  recentActions: unknown[];
};

describe('headless query workers', () => {
  it('returns the worker fleet snapshot as JSON', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'workers', '--output', 'json'],
      makeWorkersDeps(),
    );
    const snapshot = JSON.parse(output) as { generatedAt: string; workers: WorkerSnapshotEntry[] };

    expect(typeof snapshot.generatedAt).toBe('string');
    expect(snapshot.workers.length).toBeGreaterThan(0);

    // Every auto-started owner worker must appear in the fleet and be flagged
    // as auto-starting; the local snapshot cannot control workers, so each is
    // reported stopped with an empty action history.
    for (const autoKind of AUTO_STARTED_OWNER_WORKER_KINDS) {
      const entry = snapshot.workers.find(worker => worker.kind === autoKind);
      expect(entry, `missing worker ${autoKind}`).toBeDefined();
      expect(entry!.autoStarts).toBe(true);
      expect(entry!.lifecycle).toBe('stopped');
      expect(Array.isArray(entry!.recentActions)).toBe(true);
    }
  });

  it('lists worker kinds one per line in label output', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'workers', '--output', 'label'],
      makeWorkersDeps(),
    );
    const lines = output.trim().split('\n');
    for (const autoKind of AUTO_STARTED_OWNER_WORKER_KINDS) {
      expect(lines).toContain(autoKind);
    }
  });

  it('emits one worker per line in jsonl output', async () => {
    const output = await runReadOnlyHeadlessQueryToString(
      ['query', 'workers', '--output', 'jsonl'],
      makeWorkersDeps(),
    );
    const lines = output.trim().split('\n').filter(Boolean);
    const jsonKinds = new Set(lines.map(line => (JSON.parse(line) as WorkerSnapshotEntry).kind));
    for (const autoKind of AUTO_STARTED_OWNER_WORKER_KINDS) {
      expect(jsonKinds.has(autoKind)).toBe(true);
    }
  });
});
