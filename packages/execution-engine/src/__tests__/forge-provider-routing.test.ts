import { describe, expect, it, vi } from 'vitest';

import type { ForgeProvider, Logger } from '@invoker/contracts';
import { resolveTaskConfig, type TaskState } from '@invoker/workflow-core';

import { publishReviewArtifactsForMerge } from '../merge-runner.js';
import { ReviewProviderRegistry } from '../review-provider-registry.js';
import { checkMergeGateStatuses } from '../task-runner-review-gate.js';

function createProvider(name: ForgeProvider['name']): ForgeProvider {
  return {
    name,
    createReview: vi.fn().mockResolvedValue({
      url: `https://${name}.example.test/review/7`,
      identifier: `${name}-review-7`,
    }),
    checkApproval: vi.fn().mockResolvedValue({
      lifecycle: 'open',
      rejected: false,
      statusText: `${name} pending review`,
      url: `https://${name}.example.test/review/7`,
    }),
  };
}

function createRegistry(...providers: ForgeProvider[]): ReviewProviderRegistry {
  const registry = new ReviewProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return registry;
}

function createLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  vi.mocked(logger.child).mockReturnValue(logger);
  return logger;
}

function makeTask(overrides: {
  id: string;
  status: TaskState['status'];
  config?: Partial<TaskState['config']>;
  execution?: Partial<TaskState['execution']>;
}): TaskState {
  return {
    id: overrides.id,
    description: 'Test task',
    status: overrides.status,
    dependencies: [],
    createdAt: new Date(),
    config: resolveTaskConfig(overrides.config ?? {}),
    execution: { ...overrides.execution },
  };
}

describe('forge provider routing', () => {
  it('publishes a non-Invoker GitLab review through the GitLab provider', async () => {
    const github = createProvider('github');
    const gitlab = createProvider('gitlab');
    const registry = createRegistry(github, gitlab);

    const result = await publishReviewArtifactsForMerge({
      persistence: {} as any,
      orchestrator: { getAllTasks: () => [] } as any,
      defaultBranch: 'main',
      callbacks: {},
      cwd: '/repo',
      mergeGateProvider: github,
      reviewProviderRegistry: registry,
      execGitReadonly: vi.fn(),
      execGitIn: vi.fn(),
      createMergeWorktree: vi.fn(),
      removeMergeWorktree: vi.fn(),
      execGh: vi.fn(),
      execPr: vi.fn(),
      detectDefaultBranch: vi.fn(),
      gitLogMessage: vi.fn(),
      gitDiffStat: vi.fn(),
      executeTasks: vi.fn(),
      buildMergeSummary: vi.fn(),
      consolidateAndMerge: vi.fn(),
      authorPrBodyWithSkill: vi.fn().mockResolvedValue({
        body: '## Summary\n\nGitLab body',
        sessionId: 'session-1',
        agentName: 'codex',
      }),
    }, {
      mergeNodeTaskId: 'merge-gitlab',
      workflowName: 'GitLab workflow',
      baseBranch: 'main',
      featureBranch: 'feature/gitlab',
      workflowSummary: 'summary',
      cwd: '/repo/worktree',
      expectedGeneration: 3,
      repoUrl: 'https://gitlab.com/group/project',
    });

    expect(gitlab.createReview).toHaveBeenCalledWith(expect.objectContaining({
      baseBranch: 'main',
      featureBranch: 'feature/gitlab',
      title: 'GitLab workflow',
      cwd: '/repo/worktree',
      body: '## Summary\n\nGitLab body',
    }));
    expect(github.createReview).not.toHaveBeenCalled();
    expect(result.reviewGate.artifacts[0]).toEqual(expect.objectContaining({
      provider: 'gitlab',
      providerId: 'gitlab-review-7',
    }));
  });

  it('polls a GitLab workflow review gate through the GitLab provider', async () => {
    const github = createProvider('github');
    const gitlab = createProvider('gitlab');
    const registry = createRegistry(github, gitlab);
    const reviewGate = {
      activeGeneration: 2,
      completion: { required: 'all' as const, status: 'approved' as const },
      artifacts: [{
        id: 'gitlab-review',
        providerId: 'group/project!7',
        required: true,
        status: 'open' as const,
        generation: 2,
      }],
    };
    const task = makeTask({
      id: 'merge-gitlab',
      status: 'review_ready',
      config: { isMergeNode: true, workflowId: 'wf-gitlab' },
      execution: {
        generation: 2,
        selectedAttemptId: 'attempt-1',
        workspacePath: '/repo/worktree',
        reviewGate,
      },
    });
    const persistence = {
      loadWorkflow: vi.fn().mockReturnValue({
        id: 'wf-gitlab',
        repoUrl: 'https://gitlab.com/group/project',
      }),
      updateTask: vi.fn(),
    };

    await checkMergeGateStatuses({
      orchestrator: {
        getAllTasks: () => [task],
        getTask: (id: string) => (id === task.id ? task : undefined),
        recordTaskHeartbeat: vi.fn(),
        approve: vi.fn(),
      } as any,
      persistence: persistence as any,
      cwd: '/repo',
      logger: createLogger(),
      mergeGateProvider: github,
      reviewProviderRegistry: registry,
      executeTasks: vi.fn(),
      reviewGateCiFailureInFlight: new Set(),
      reviewGateMergeConflictInFlight: new Set(),
    });

    expect(gitlab.checkApproval).toHaveBeenCalledWith({
      identifier: 'group/project!7',
      cwd: '/repo/worktree',
    });
    expect(github.checkApproval).not.toHaveBeenCalled();
    expect(persistence.updateTask).toHaveBeenCalledWith('merge-gitlab', expect.objectContaining({
      execution: expect.objectContaining({ reviewStatus: 'gitlab pending review' }),
    }));
  });

  it('polls through the provider recorded on the review artifact before the workflow URL', async () => {
    const github = createProvider('github');
    const gitlab = createProvider('gitlab');
    const registry = createRegistry(github, gitlab);
    const reviewGate = {
      activeGeneration: 2,
      completion: { required: 'all' as const, status: 'approved' as const },
      artifacts: [{
        id: 'gitlab-review',
        provider: 'gitlab',
        providerId: 'group/project!7',
        required: true,
        status: 'open' as const,
        generation: 2,
      }],
    };
    const task = makeTask({
      id: 'merge-gitlab',
      status: 'review_ready',
      config: { isMergeNode: true, workflowId: 'wf-gitlab' },
      execution: {
        generation: 2,
        selectedAttemptId: 'attempt-1',
        workspacePath: '/repo/worktree',
        reviewGate,
      },
    });
    const persistence = {
      loadWorkflow: vi.fn().mockReturnValue({
        id: 'wf-gitlab',
        repoUrl: 'https://github.com/group/project',
      }),
      updateTask: vi.fn(),
    };

    await checkMergeGateStatuses({
      orchestrator: {
        getAllTasks: () => [task],
        getTask: (id: string) => (id === task.id ? task : undefined),
        recordTaskHeartbeat: vi.fn(),
        approve: vi.fn(),
      } as any,
      persistence: persistence as any,
      cwd: '/repo',
      logger: createLogger(),
      mergeGateProvider: github,
      reviewProviderRegistry: registry,
      executeTasks: vi.fn(),
      reviewGateCiFailureInFlight: new Set(),
      reviewGateMergeConflictInFlight: new Set(),
    });

    expect(gitlab.checkApproval).toHaveBeenCalledWith({
      identifier: 'group/project!7',
      cwd: '/repo/worktree',
    });
    expect(github.checkApproval).not.toHaveBeenCalled();
  });
});
