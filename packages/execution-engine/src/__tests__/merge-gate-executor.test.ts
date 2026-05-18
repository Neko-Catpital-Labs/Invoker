import { describe, expect, it, vi } from 'vitest';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';

vi.mock('../merge-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../merge-runner.js')>();
  return {
    ...actual,
    runMergeGateActionImpl: vi.fn(),
  };
});

import { MergeGateExecutor } from '../merge-gate-executor.js';
import { runMergeGateActionImpl } from '../merge-runner.js';

const mockedRunMergeGateActionImpl = vi.mocked(runMergeGateActionImpl);

function makeRequest(): WorkRequest {
  return {
    requestId: 'req-merge',
    actionId: '__merge__wf-test',
    actionType: 'merge_gate',
    inputs: {},
    callbackUrl: '',
    timestamps: { createdAt: new Date().toISOString() },
    attemptId: 'attempt-merge',
    executionGeneration: 1,
  };
}

function makeTask(): TaskState {
  return {
    id: '__merge__wf-test',
    description: 'Merge gate',
    status: 'running',
    dependencies: [],
    dependents: [],
    config: { workflowId: 'wf-test' },
    execution: {
      generation: 1,
      selectedAttemptId: 'attempt-merge',
    },
  } as TaskState;
}

function makeHost(task: TaskState) {
  return {
    orchestrator: {
      getTask: vi.fn().mockReturnValue(task),
    },
    persistence: {
      loadWorkflow: vi.fn().mockReturnValue({
        id: 'wf-test',
        baseBranch: 'master',
        featureBranch: 'plan/wf-test',
      }),
      updateTask: vi.fn(),
    },
    defaultBranch: 'master',
    detectDefaultBranch: vi.fn().mockResolvedValue('master'),
    createMergeWorktree: vi.fn().mockResolvedValue('/tmp/merge-gate-worktree'),
    startPrPolling: vi.fn(),
  } as any;
}

describe('MergeGateExecutor', () => {
  it('lets an in-flight merge gate emit its terminal response during destroyAll', async () => {
    const task = makeTask();
    const host = makeHost(task);
    const executor = new MergeGateExecutor(host);
    const response: WorkResponse = {
      requestId: 'runner-req',
      actionId: task.id,
      status: 'completed',
      outputs: { exitCode: 0 },
    };
    mockedRunMergeGateActionImpl.mockResolvedValue({
      response,
      taskChanges: {},
    } as any);

    const handle = await executor.start(makeRequest());
    const completions: WorkResponse[] = [];
    executor.onComplete(handle, (completed) => completions.push(completed));

    await executor.destroyAll();

    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      requestId: 'req-merge',
      actionId: task.id,
      attemptId: 'attempt-merge',
      executionGeneration: 1,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
  });
});
