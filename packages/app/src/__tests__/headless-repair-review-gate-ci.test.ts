import { describe, expect, it, vi } from 'vitest';
import type { WorkflowMutationIntent, WorkflowMutationPriority } from '@invoker/data-store';
import { LocalBus, type MessageBus } from '@invoker/transport';
import { createAutoFixAttemptLedger, type WorkerActionRecord, type WorkerActionWrite } from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

import { runHeadless, tryDelegateExec, type HeadlessDeps } from '../headless.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(() => logger),
};

function makeReviewReadyTask(): TaskState {
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

function makeDeps(task: TaskState = makeReviewReadyTask()) {
  const actions = new Map<string, WorkerActionRecord>();
  const submit = vi.fn((
    _workflowId: string,
    _priority: WorkflowMutationPriority,
    _channel: string,
    _args: unknown[],
  ) => 99);
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
    invokerConfig: { autoFixRetries: 2, autoFixAgent: 'codex' },
    initServices: vi.fn(async () => {}),
    wireSlackBot: vi.fn(async () => ({})),
    reviewGateCiRepairSubmitter: { submit },
    reviewGateCiRepairAttemptLedger: createAutoFixAttemptLedger(),
  } satisfies HeadlessDeps;
  return { deps, submit };
}

describe('headless repair-review-gate-ci', () => {
  it('preserves the command shape and prints queued JSON for workflow-mapped PRs', async () => {
    const { deps, submit } = makeDeps();
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runHeadless(['repair-review-gate-ci', '123', '--output', 'json'], deps);
      expect(submit).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(stdout.mock.calls[0]?.[0] as string);
      expect(parsed).toMatchObject({
        decision: 'queued',
        reason: 'queued',
        intentId: 99,
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

  it('prints unmapped text without requiring a submitter', async () => {
    const { deps, submit } = makeDeps();
    deps.reviewGateCiRepairSubmitter = undefined;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runHeadless(['repair-review-gate-ci', '456'], deps);
      expect(submit).not.toHaveBeenCalled();
      expect(stdout.mock.calls[0]?.[0]).toBe('unmapped review-gate CI repair target "456" reason=no-workflow-review-gate\n');
    } finally {
      stdout.mockRestore();
    }
  });

  it('prints owner-returned repair outcomes for delegated headless invocations', async () => {
    const messageBus = new LocalBus() as MessageBus;
    const repairMessage = 'queued review-gate CI repair for "123" workflow=wf-1 task=wf-1/merge review=123 reason=queued intent=99\n';
    messageBus.onRequest('headless.exec', async (req: unknown) => {
      expect(req).toMatchObject({ args: ['repair-review-gate-ci', '123'] });
      return {
        ok: true,
        message: repairMessage,
      };
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const outcome = await tryDelegateExec(['repair-review-gate-ci', '123'], messageBus);
      expect(outcome).toMatchObject({
        kind: 'delegated',
        message: repairMessage,
      });
      expect(stdout.mock.calls.map((call) => String(call[0])).join('')).toContain(
        repairMessage,
      );
    } finally {
      stdout.mockRestore();
    }
  });
});
