import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandService, Orchestrator, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter, WorkflowMutationPriority } from '@invoker/data-store';
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

function makeMergeTask(): TaskState {
  return {
    id: 'wf-1/merge',
    description: 'Review gate',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    config: { workflowId: 'wf-1', isMergeNode: true, runnerKind: 'merge' },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      reviewGate: {
        activeGeneration: 2,
        artifacts: [{
          id: 'pr-123',
          providerId: '123',
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
  } as TaskState;
}

function makeDeps(task: TaskState = makeMergeTask()) {
  const actions = new Map<string, any>();
  const submit = vi.fn((
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
  ) => {
    expect(workflowId).toBe('wf-1');
    expect(priority).toBe('normal');
    expect(channel).toBe('invoker:fix-with-agent');
    expect(args[0]).toBe('wf-1/merge');
    return 77;
  });
  const persistence = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'Workflow', status: 'running', createdAt: '', updatedAt: '' }]),
    loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-1' ? [task] : []),
    loadTask: vi.fn((taskId: string) => taskId === task.id ? task : undefined),
    listWorkflowMutationIntents: vi.fn(() => []),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: any) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const saved = {
        ...write,
        id: existing?.id ?? write.id,
        attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
        createdAt: existing?.createdAt ?? '2026-01-01T00:00:00Z',
        updatedAt: write.updatedAt ?? '2026-01-01T00:00:00Z',
      };
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  } as unknown as SQLiteAdapter;
  const onReviewGateCiRepairResult = vi.fn();
  const deps: HeadlessDeps = {
    logger: logger as any,
    orchestrator: {} as Orchestrator,
    persistence,
    commandService: {} as CommandService,
    executorRegistry: {} as any,
    messageBus: new LocalBus() as MessageBus,
    repoRoot: '/fake/repo',
    invokerConfig: { autoFixRetries: 2, autoFixAgent: 'codex' } as any,
    initServices: vi.fn(async () => {}),
    wireSlackBot: vi.fn(async () => ({})),
    reviewGateCiRepairSubmitter: { submit },
    onReviewGateCiRepairResult,
  };
  return { deps, submit, onReviewGateCiRepairResult };
}

describe('headless repair-review-gate-ci', () => {
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    vi.clearAllMocks();
  });

  it('prints queued outcome and reports it through the delegation callback', async () => {
    const { deps, submit, onReviewGateCiRepairResult } = makeDeps();

    await runHeadless(['repair-review-gate-ci', '123'], deps);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(onReviewGateCiRepairResult).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'queued',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
      intentId: 77,
    }));
    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain('review-gate-ci-repair: queued');
  });

  it('requires the mutation submitter instead of running repair directly', async () => {
    const { deps } = makeDeps();
    delete deps.reviewGateCiRepairSubmitter;

    await expect(runHeadless(['repair-review-gate-ci', '123'], deps)).rejects.toThrow(
      'Review-gate CI repair submitter is unavailable',
    );
  });
});
