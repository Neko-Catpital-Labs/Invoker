import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import { runMergeGateActionImpl, type MergeRunnerHost } from '../merge-runner.js';

const MERGE_TASK_ID = '__merge__wf-noop';

function makeMergeTask(): TaskState {
  return {
    id: MERGE_TASK_ID,
    description: 'No-op gate',
    status: 'running',
    dependencies: ['t1'],
    createdAt: new Date(),
    config: { isMergeNode: true, workflowId: 'wf-noop' } as TaskState['config'],
    execution: { generation: 0 },
  } as TaskState;
}

describe('merge gate no_op mode', () => {
  it('completes without worktree, consolidate, or review publication', async () => {
    const createMergeWorktree = vi.fn(async () => '/tmp/should-not-create');
    const consolidateAndMerge = vi.fn(async () => undefined);
    const createReview = vi.fn(async () => ({ url: 'https://example.invalid/pr/1', identifier: '1' }));

    const host = {
      cwd: '/tmp/host-repo',
      defaultBranch: 'master',
      persistence: {
        loadWorkflow: () => ({
          id: 'wf-noop',
          onFinish: 'none',
          mergeMode: 'no_op',
          baseBranch: 'master',
          featureBranch: 'plan/noop-feature',
          name: 'No-op Workflow',
        }),
        updateTask: vi.fn(),
        getWorkspacePath: () => null,
      },
      orchestrator: {
        getTask: () => makeMergeTask(),
        getAllTasks: () => [makeMergeTask()],
        autoStartExternallyUnblockedReadyTasks: () => [],
      },
      createMergeWorktree,
      consolidateAndMerge,
      mergeGateProvider: { createReview },
      async detectDefaultBranch() {
        return 'master';
      },
      async buildMergeSummary() {
        return '## Summary';
      },
    } as unknown as MergeRunnerHost;

    const result = await runMergeGateActionImpl(host, makeMergeTask());

    expect(result.response.status).toBe('completed');
    expect(result.response.outputs.exitCode).toBe(0);
    expect(createMergeWorktree).not.toHaveBeenCalled();
    expect(consolidateAndMerge).not.toHaveBeenCalled();
    expect(createReview).not.toHaveBeenCalled();
  });
});
