import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandService, Orchestrator, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { MessageBus } from '@invoker/transport';
import { LocalBus } from '@invoker/transport';

import { runHeadless, type HeadlessDeps } from '../headless.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function () { return logger; }),
};

function makeMergeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/merge',
    description: 'Review gate',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    config: { workflowId: 'wf-1', isMergeNode: true, runnerKind: 'merge' },
    execution: {
      generation: 2,
      reviewGate: {
        activeGeneration: 2,
        artifacts: [{
          id: 'pr-123',
          providerId: '123',
          provider: 'github',
          required: true,
          status: 'open',
          generation: 2,
          url: 'https://github.com/owner/repo/pull/123',
          headSha: 'sha-1',
          checksState: 'failure',
          failedChecks: [{ name: 'unit', conclusion: 'FAILURE' }],
          rawStatus: 'CI failed',
        }],
      },
    },
    taskStateVersion: 1,
    ...overrides,
  } as TaskState;
}

function makeDeps(task: TaskState = makeMergeTask()): HeadlessDeps {
  return {
    logger: logger as any,
    orchestrator: {} as Orchestrator,
    persistence: {
      listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'Workflow', status: 'running', createdAt: '', updatedAt: '' }]),
      loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-1' ? [task] : []),
      loadTask: vi.fn((taskId: string) => taskId === task.id ? task : undefined),
      listWorkflowMutationIntents: vi.fn(() => []),
      getWorkerAction: vi.fn(),
      upsertWorkerAction: vi.fn(),
      logEvent: vi.fn(),
    } as unknown as SQLiteAdapter,
    commandService: {} as CommandService,
    executorRegistry: {} as any,
    messageBus: new LocalBus() as MessageBus,
    repoRoot: '/fake/repo',
    invokerConfig: {} as any,
    initServices: vi.fn(async () => {}),
    wireSlackBot: vi.fn(async () => ({})),
  };
}

describe('headless query review-gate', () => {
  let stdout: any;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    vi.clearAllMocks();
  });

  it('reports a workflow-mapped current CI failure as queueable', async () => {
    await runHeadless(['query', 'review-gate', '123', '--output', 'json'], makeDeps());

    const parsed = JSON.parse(stdout.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      ok: true,
      decision: 'queued',
      reason: 'current-ci-failure',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
      reviewId: '123',
      reviewUrl: 'https://github.com/owner/repo/pull/123',
    });
  });

  it('reports unmapped when no review gate references the PR', async () => {
    await runHeadless(['query', 'review-gate', '999', '--output', 'json'], makeDeps());

    const parsed = JSON.parse(stdout.mock.calls[0][0] as string);
    expect(parsed).toEqual({
      ok: true,
      decision: 'unmapped',
      reason: 'no-workflow-mapped-review-gate',
      target: { input: '999', prNumber: '999', reviewId: '999' },
    });
  });
});
