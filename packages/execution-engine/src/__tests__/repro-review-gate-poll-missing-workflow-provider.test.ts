import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import type { MergeGateApprovalStatus, MergeGateProvider } from '../merge-gate-provider.js';
import { ReviewProviderRegistry } from '../review-provider-registry.js';
import { pollMergeGateTask, type TaskRunnerReviewGateHost } from '../task-runner-review-gate.js';

const GITLAB_MR_ID = '77';
const GITLAB_MR_URL = 'https://gitlab.com/group/project/-/merge_requests/77';
const GITHUB_PR_URL = 'https://github.com/owner/repo/pull/77';

const OPEN_STATUS: MergeGateApprovalStatus = {
  lifecycle: 'open',
  rejected: false,
  statusText: 'Awaiting review',
  url: GITLAB_MR_URL,
  headSha: 'abc123',
};

function mergeGateTask(options: {
  config?: TaskState['config'];
  provider?: string;
  url?: string;
}): TaskState {
  return {
    id: '__merge__wf-missing-config',
    description: 'merge gate persisted without config',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-10-21T00:00:00.000Z'),
    ...(options.config ? { config: options.config } : {}),
    execution: {
      generation: 1,
      selectedAttemptId: 'attempt-1',
      reviewId: GITLAB_MR_ID,
      branch: 'invoker/missing-config',
      reviewGate: {
        activeGeneration: 1,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: GITLAB_MR_ID,
          title: 'missing config',
          url: options.url ?? GITLAB_MR_URL,
          providerId: GITLAB_MR_ID,
          ...(options.provider ? { provider: options.provider } : {}),
          branch: 'invoker/missing-config',
          baseBranch: 'main',
          required: true,
          status: 'open',
          generation: 1,
        }],
      },
    },
    taskStateVersion: 3,
  } as unknown as TaskState;
}

function fakeProvider(name: string) {
  const checkApproval = vi.fn(async () => OPEN_STATUS);
  const provider = { name, checkApproval } as unknown as MergeGateProvider;
  return { provider, checkApproval };
}

function pollHost(options: {
  task: TaskState;
  registry?: ReviewProviderRegistry;
  mergeGateProvider?: MergeGateProvider;
  workflow?: { repoUrl: string };
}) {
  const updateTask = vi.fn();
  const loadWorkflow = vi.fn(() => options.workflow);
  const host = {
    orchestrator: {
      recordTaskHeartbeat: vi.fn(),
      getTask: () => options.task,
      approve: vi.fn(async () => []),
    },
    persistence: { loadWorkflow, updateTask },
    cwd: '/tmp/invoker-poll-test',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    mergeGateProvider: options.mergeGateProvider,
    reviewProviderRegistry: options.registry,
    executeTasks: vi.fn(),
    reviewGateCiFailurePublisher: undefined,
    reviewGateCiFailureInFlight: new Set<string>(),
    reviewGateMergeConflictPublisher: undefined,
    reviewGateMergeConflictInFlight: new Set<string>(),
  } as unknown as TaskRunnerReviewGateHost;
  return { host, updateTask, loadWorkflow };
}

describe('pollMergeGateTask when task.config is absent and a provider registry is set', () => {
  it('polls the persisted artifact provider instead of needing a workflow repoUrl', async () => {
    const gitlab = fakeProvider('gitlab');
    const github = fakeProvider('github');
    const registry = new ReviewProviderRegistry();
    registry.register(github.provider);
    registry.register(gitlab.provider);
    const task = mergeGateTask({ provider: 'gitlab' });
    const { host, updateTask, loadWorkflow } = pollHost({ task, registry });

    await expect(pollMergeGateTask(host, task, 'manual check')).resolves.toBeUndefined();

    expect(loadWorkflow).not.toHaveBeenCalled();
    expect(gitlab.checkApproval).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: GITLAB_MR_ID }),
    );
    expect(github.checkApproval).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        execution: expect.objectContaining({ reviewStatus: 'Awaiting review' }),
      }),
    );
  });

  it('fails closed when the recorded provider is not registered and there is no workflow', async () => {
    const github = fakeProvider('github');
    const registry = new ReviewProviderRegistry();
    registry.register(github.provider);
    const task = mergeGateTask({ provider: 'gitlab' });
    const { host, updateTask } = pollHost({ task, registry });

    await expect(pollMergeGateTask(host, task, 'manual check')).rejects.toThrow(
      /forge provider/,
    );

    expect(github.checkApproval).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('rejects instead of polling another forge when the recorded provider is unregistered and the workflow is GitHub', async () => {
    const github = fakeProvider('github');
    const registry = new ReviewProviderRegistry();
    registry.register(github.provider);
    const task = mergeGateTask({
      config: { workflowId: 'wf-1', isMergeNode: true } as TaskState['config'],
      provider: 'gitlab',
    });
    const { host, updateTask } = pollHost({
      task,
      registry,
      workflow: { repoUrl: 'https://github.com/owner/repo.git' },
    });

    await expect(pollMergeGateTask(host, task, 'refresh')).rejects.toThrow(/forge provider/);

    expect(github.checkApproval).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('still selects the provider from the workflow repoUrl when the artifact records none', async () => {
    const gitlab = fakeProvider('gitlab');
    const github = fakeProvider('github');
    const registry = new ReviewProviderRegistry();
    registry.register(github.provider);
    registry.register(gitlab.provider);
    const task = mergeGateTask({
      config: { workflowId: 'wf-1', isMergeNode: true } as TaskState['config'],
      url: GITHUB_PR_URL,
    });
    const { host, loadWorkflow } = pollHost({
      task,
      registry,
      workflow: { repoUrl: 'https://github.com/owner/repo.git' },
    });

    await expect(pollMergeGateTask(host, task, 'refresh')).resolves.toBeUndefined();

    expect(loadWorkflow).toHaveBeenCalledWith('wf-1');
    expect(github.checkApproval).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: GITLAB_MR_ID }),
    );
    expect(gitlab.checkApproval).not.toHaveBeenCalled();
  });
});
