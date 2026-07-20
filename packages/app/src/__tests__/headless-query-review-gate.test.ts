import { describe, expect, it, vi } from 'vitest';
import type { WorkflowMutationIntent, WorkflowMutationPriority } from '@invoker/data-store';
import { LocalBus, type MessageBus } from '@invoker/transport';
import { createAutoFixAttemptLedger, type WorkerActionRecord, type WorkerActionWrite } from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

import { runHeadless, type HeadlessDeps } from '../headless.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(() => logger),
};

function makeTask(artifactOverrides: Record<string, unknown> = {}): TaskState {
  return {
    id: 'wf-1/merge',
    description: 'Merge gate',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: {
      generation: 1,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/ci',
      reviewGate: {
        activeGeneration: 1,
        artifacts: [{
          id: 'pr-123',
          providerId: '123',
          required: true,
          status: 'open',
          generation: 1,
          url: 'https://github.com/owner/repo/pull/123',
          headSha: 'sha-1',
          checksState: 'failure',
          failedChecks: [{ name: 'unit', conclusion: 'FAILURE' }],
          rawStatus: 'CI failed',
          ...artifactOverrides,
        }],
      },
    },
    taskStateVersion: 1,
  } as TaskState;
}

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: write.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

function makeDeps(task: TaskState = makeTask()) {
  const actions = new Map<string, WorkerActionRecord>();
  const submit = vi.fn((
    _workflowId: string,
    _priority: WorkflowMutationPriority,
    _channel: string,
    _args: unknown[],
  ) => 314);
  const persistence = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-1' ? [task] : []),
    loadTask: vi.fn((taskId: string) => taskId === task.id ? task : undefined),
    listWorkflowMutationIntents: vi.fn((): WorkflowMutationIntent[] => []),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const saved = toRecord(write);
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  const deps = {
    logger,
    orchestrator: {} as any,
    persistence: persistence as any,
    executorRegistry: {} as any,
    messageBus: new LocalBus() as MessageBus,
    commandService: {} as any,
    repoRoot: '/repo',
    invokerConfig: { autoFixRetries: 2 },
    initServices: vi.fn(async () => {}),
    wireSlackBot: vi.fn(async () => ({})),
    reviewGateCiRepairSubmitter: { submit },
    reviewGateCiRepairAttemptLedger: createAutoFixAttemptLedger(),
  } satisfies HeadlessDeps;
  return deps;
}

describe('headless query review-gate-ci', () => {
  it('reports queued outcome for a PR after repair is queued', async () => {
    const deps = makeDeps();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runHeadless(['repair-review-gate-ci', '123', '--output', 'json'], deps);
      stdout.mockClear();

      await runHeadless(['query', 'review-gate-ci', '123', '--output', 'json'], deps);
      const parsed = JSON.parse(stdout.mock.calls[0][0] as string);

      expect(parsed).toMatchObject({
        decision: 'queued',
        reason: 'already-recorded',
        intentId: '314',
        mapping: {
          workflowId: 'wf-1',
          taskId: 'wf-1/merge',
          reviewId: '123',
        },
      });
    } finally {
      stdout.mockRestore();
    }
  });

  it('reports skipped for mapped PRs that are not CI-repairable', async () => {
    const deps = makeDeps(makeTask({ checksState: 'success', failedChecks: [] }));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runHeadless(['query', 'review-gate-ci', '123', '--output', 'json'], deps);
      const parsed = JSON.parse(stdout.mock.calls[0][0] as string);

      expect(parsed).toMatchObject({
        decision: 'skipped',
        reason: 'ci-not-failing',
        mapping: {
          workflowId: 'wf-1',
          taskId: 'wf-1/merge',
          repairable: false,
        },
      });
    } finally {
      stdout.mockRestore();
    }
  });

  it('reports unmapped as a label for PRs not tied to a workflow', async () => {
    const deps = makeDeps();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runHeadless(['query', 'review-gate-ci', '456', '--output', 'label'], deps);
      expect(stdout.mock.calls[0][0]).toBe('unmapped\n');
    } finally {
      stdout.mockRestore();
    }
  });
});
