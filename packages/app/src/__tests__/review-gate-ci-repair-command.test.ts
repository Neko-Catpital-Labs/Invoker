import { describe, expect, it, vi } from 'vitest';
import type { WorkflowMutationIntent, WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  createAutoFixAttemptLedger,
  parseFixWithAgentMutationArgs,
  type WorkerActionRecord,
  type WorkerActionWrite,
} from '@invoker/execution-engine';

import {
  inspectReviewGateCiRepairTarget,
  repairReviewGateCiForTarget,
  resolveReviewGateCiRepairWorkflowId,
} from '../review-gate-ci-repair-command.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(() => logger),
};

function makeTask(overrides: Partial<TaskState> & { execution?: Record<string, unknown> } = {}): TaskState {
  return {
    id: 'wf-1/merge',
    description: 'Merge gate',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/ci',
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
          headRef: 'feature/ci',
          checksState: 'failure',
          failedChecks: [
            { name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/1' },
          ],
          rawStatus: 'CI failed',
        }],
      },
      ...(overrides.execution ?? {}),
    },
    taskStateVersion: 10,
    ...overrides,
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

function makeHarness(task = makeTask()) {
  const actions = new Map<string, WorkerActionRecord>();
  const submit = vi.fn((
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
  ) => {
    expect(workflowId).toBe('wf-1');
    expect(priority).toBe('normal');
    expect(channel).toBe('invoker:fix-with-agent');
    expect(args.length).toBeGreaterThan(0);
    return 42;
  });
  const store = {
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
  return {
    actions,
    store,
    submitter: { submit },
    submit,
    deps: {
      store,
      submitter: { submit },
      logger,
      defaultAutoFixRetries: 2,
      getAutoFixAgent: () => 'codex',
      getAutoFixExecutionModel: () => 'openai/gpt-5.2',
      attemptLedger: createAutoFixAttemptLedger(),
      now: () => '2026-01-01T00:00:00.000Z',
    },
  };
}

describe('review-gate CI repair command', () => {
  it('maps a PR target to its workflow and queues through queueReviewGateCiRepair', async () => {
    const harness = makeHarness();

    const result = await repairReviewGateCiForTarget('https://github.com/owner/repo/pull/123', harness.deps);

    expect(result).toMatchObject({
      decision: 'queued',
      reason: 'queued',
      intentId: 42,
      mapping: {
        workflowId: 'wf-1',
        taskId: 'wf-1/merge',
        reviewId: '123',
        headSha: 'sha-1',
      },
    });
    expect(harness.submit).toHaveBeenCalledTimes(1);
    const [, , , args] = harness.submit.mock.calls[0];
    expect(parseFixWithAgentMutationArgs(args)).toMatchObject({
      taskId: 'wf-1/merge',
      agentName: 'codex',
      context: {
        autoFix: true,
        executionModel: 'openai/gpt-5.2',
        reviewGateContext: {
          reviewId: '123',
          generation: 2,
          selectedAttemptId: 'attempt-1',
          headSha: 'sha-1',
          branch: 'feature/ci',
        },
      },
    });
  });

  it('reports queued in query inspection when the repair action is already open', async () => {
    const harness = makeHarness();
    await repairReviewGateCiForTarget('123', harness.deps);

    const inspection = inspectReviewGateCiRepairTarget('123', {
      store: harness.store,
      logger,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    expect(inspection).toMatchObject({
      decision: 'queued',
      reason: 'already-recorded',
      intentId: '42',
      mapping: {
        workflowId: 'wf-1',
        taskId: 'wf-1/merge',
      },
    });
  });

  it('returns skipped when queueReviewGateCiRepair dedupes an already-recorded action', async () => {
    const harness = makeHarness();

    await repairReviewGateCiForTarget('123', harness.deps);
    const result = await repairReviewGateCiForTarget('123', harness.deps);

    expect(result).toMatchObject({
      decision: 'skipped',
      reason: 'already-recorded',
      intentId: undefined,
    });
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it('returns unmapped when no workflow owns the PR target', async () => {
    const harness = makeHarness();

    const result = await repairReviewGateCiForTarget('456', {
      store: harness.store,
      logger,
      defaultAutoFixRetries: 2,
    });

    expect(result).toEqual({
      decision: 'unmapped',
      reason: 'no-workflow-review-gate',
      target: '456',
      mappedCount: 0,
    });
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it('resolves workflow ids for owner-side PR command serialization', () => {
    const harness = makeHarness();

    expect(resolveReviewGateCiRepairWorkflowId('owner/repo#123', {
      store: harness.store,
      logger,
      now: () => '2026-01-01T00:00:00.000Z',
    })).toBe('wf-1');
  });
});
