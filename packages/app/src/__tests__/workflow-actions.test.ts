/**
 * Unit tests for shared workflow action functions.
 *
 * Each function is tested with mocked orchestrator/persistence deps,
 * following the pattern from resolve-conflict-action.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCancelInFlight, buildWorkflowInvalidationDeps, type Orchestrator } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { TaskRunner } from '@invoker/execution-engine';

const loadConfigMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

import {
  cancelWorkflow,
  recreateWorkflowFromFreshBase,
  rebaseRetry,
  rebaseRecreate,
  approveTask,
  rejectTask,
  provideInput,
  editTaskCommand,
  editTaskPrompt,
  selectExperiment,
  setWorkflowMergeMode,
  fixWithAgentAction,
  finalizeAppliedFix,
  autoFixOnFailure,
  selectFailureRecoveryRoute,
  deleteAllWorkflows,
  resolveConflictAction,
  StaleLineageError,
  captureTaskLineage,
  assertLineageCurrent,
} from '../workflow-actions.js';

vi.mock('../delete-all-snapshot.js', () => ({
  createDeleteAllSnapshot: () => '/tmp/fake-snapshot',
}));

beforeEach(() => {
  loadConfigMock.mockReturnValue({});
});

// ── Helpers ──────────────────────────────────────────────────

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-a',
    status: 'pending' as const,
    description: 'test task',
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId: 'wf-1' },
    execution: {},
    ...overrides,
  };
}

function makeRunningTask(overrides: Record<string, unknown> = {}) {
  return makeTask({ status: 'running', ...overrides });
}

// ── Tests ────────────────────────────────────────────────────


function makeCommandService() {
  return {
    runSerializedForWorkflow: vi.fn(async (_workflowId: string | undefined, fn: () => Promise<unknown> | unknown) => ({
      ok: true as const,
      data: await fn(),
    })),
  } as any;
}
describe('fresh-base workflow lifecycle helpers', () => {
  it('routes recreateWorkflowFromFreshBase through CommandService/applyInvalidation', async () => {
    const tasks = [makeRunningTask()];
    const orchestrator = {
      getTask: vi.fn(),
      cancelWorkflow: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      recreateWorkflowFromFreshBase: vi.fn(async () => tasks),
      cascadeInvalidationToDownstream: vi.fn(() => []),
    };
    const persistence = {
      loadWorkflow: vi.fn(() => ({
        id: 'wf-1',
        generation: 4,
        repoUrl: 'https://example/repo.git',
        baseBranch: 'main',
      })),
      updateWorkflow: vi.fn(),
    };
    const taskExecutor = {
      preparePoolForRebaseRetry: vi.fn(async () => undefined),
      killActiveExecution: vi.fn(async () => undefined),
    } as unknown as TaskRunner;
    const commandService = makeCommandService();

    const result = await recreateWorkflowFromFreshBase('wf-1', {
      commandService,
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor,
    });

    expect(commandService.runSerializedForWorkflow).toHaveBeenCalledWith('wf-1', expect.any(Function));
    expect(persistence.updateWorkflow).not.toHaveBeenCalled();
    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith(
      'wf-1',
      expect.objectContaining({ refreshBase: expect.any(Function) }),
    );
    expect(taskExecutor.preparePoolForRebaseRetry).toHaveBeenCalledWith(
      'wf-1',
      'https://example/repo.git',
      'main',
    );
    expect(orchestrator.cascadeInvalidationToDownstream).toHaveBeenCalledWith('wf-1');
    expect(result).toBe(tasks);
  });

  it('throws when workflow not found before direct primitive use', async () => {
    const commandService = makeCommandService();
    const orchestrator = {
      cancelWorkflow: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      recreateWorkflowFromFreshBase: vi.fn(async () => []),
      cascadeInvalidationToDownstream: vi.fn(() => []),
    };
    const persistence = { loadWorkflow: vi.fn(() => undefined), updateWorkflow: vi.fn() };

    await expect(
      recreateWorkflowFromFreshBase('missing', {
        commandService,
        orchestrator: orchestrator as unknown as Orchestrator,
        persistence: persistence as unknown as SQLiteAdapter,
      }),
    ).rejects.toThrow('Workflow missing not found');
    expect(orchestrator.recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
  });
});

describe('rebaseRetry', () => {
  it('serializes through CommandService and cascades after retryWorkflow', async () => {
    const tasks = [makeRunningTask()];
    const orchestrator = {
      getTask: vi.fn(() => makeTask({ config: { workflowId: 'wf-1' } })),
      cancelWorkflow: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      retryWorkflow: vi.fn(() => tasks),
      cascadeInvalidationToDownstream: vi.fn(() => []),
    };
    const persistence = {
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 1, repoUrl: 'https://example/repo.git', baseBranch: 'master' })),
      listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
      loadTasks: vi.fn(() => []),
      updateWorkflow: vi.fn(),
    };
    const taskExecutor = {
      preparePoolForRebaseRetry: vi.fn(async () => undefined),
      killActiveExecution: vi.fn(async () => undefined),
    } as unknown as TaskRunner;
    const commandService = makeCommandService();

    const result = await rebaseRetry('wf-1/task-a', {
      commandService,
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor,
    });

    expect(commandService.runSerializedForWorkflow).toHaveBeenCalledWith('wf-1', expect.any(Function));
    expect(taskExecutor.preparePoolForRebaseRetry).toHaveBeenCalled();
    expect(orchestrator.retryWorkflow).toHaveBeenCalledWith('wf-1');
    expect(orchestrator.cascadeInvalidationToDownstream).toHaveBeenCalledWith('wf-1');
    expect(result).toBe(tasks);
  });

  it('throws when target cannot resolve to a workflow', async () => {
    const orchestrator = {
      getTask: vi.fn(() => undefined),
      retryWorkflow: vi.fn(),
    };
    const persistence = { loadWorkflow: vi.fn(), listWorkflows: vi.fn(() => []), loadTasks: vi.fn(() => []), updateWorkflow: vi.fn() };

    await expect(
      rebaseRetry('missing-task', {
        commandService: makeCommandService(),
        orchestrator: orchestrator as unknown as Orchestrator,
        persistence: persistence as unknown as SQLiteAdapter,
      }),
    ).rejects.toThrow('Could not resolve workflow for rebase target "missing-task"');
  });
});

describe('rebaseRecreate', () => {
  it('serializes through CommandService and cascades fresh-base recreate', async () => {
    const tasks = [makeRunningTask()];
    const orchestrator = {
      getTask: vi.fn(() => undefined),
      cancelWorkflow: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      recreateWorkflowFromFreshBase: vi.fn(async () => tasks),
      cascadeInvalidationToDownstream: vi.fn(() => []),
    };
    const persistence = {
      loadWorkflow: vi.fn(() => ({
        id: 'wf-1',
        generation: 2,
        repoUrl: 'https://example/repo.git',
        baseBranch: 'main',
      })),
      updateWorkflow: vi.fn(),
      listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
      loadTasks: vi.fn(() => []),
    };
    const taskExecutor = {
      preparePoolForRebaseRetry: vi.fn(async () => undefined),
      killActiveExecution: vi.fn(async () => undefined),
    } as unknown as TaskRunner;
    const commandService = makeCommandService();

    const result = await rebaseRecreate('wf-1', {
      commandService,
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor,
    });

    expect(commandService.runSerializedForWorkflow).toHaveBeenCalledWith('wf-1', expect.any(Function));
    expect(persistence.updateWorkflow).not.toHaveBeenCalled();
    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith(
      'wf-1',
      expect.objectContaining({ refreshBase: expect.any(Function) }),
    );
    expect(orchestrator.cascadeInvalidationToDownstream).toHaveBeenCalledWith('wf-1');
    expect(result).toBe(tasks);
  });

  it('throws when workflow not found', async () => {
    const orchestrator = { getTask: vi.fn(() => undefined), recreateWorkflowFromFreshBase: vi.fn(async () => []) };
    const persistence = { loadWorkflow: vi.fn(() => undefined), listWorkflows: vi.fn(() => []), loadTasks: vi.fn(() => []), updateWorkflow: vi.fn() };

    await expect(
      rebaseRecreate('missing', {
        commandService: makeCommandService(),
        orchestrator: orchestrator as unknown as Orchestrator,
        persistence: persistence as unknown as SQLiteAdapter,
      }),
    ).rejects.toThrow('Could not resolve workflow for rebase target "missing"');
  });
});

describe('workflow lifecycle invariant', () => {
  it('does not expose direct app-layer retry/recreate wrappers', async () => {
    const actions = await import('../workflow-actions.js');
    expect('retryTask' in actions).toBe(false);
    expect('recreateTask' in actions).toBe(false);
    expect('retryWorkflow' in actions).toBe(false);
    expect('recreateWorkflow' in actions).toBe(false);
    expect('bumpGenerationAndRecreate' in actions).toBe(false);
  });
});

describe('approveTask', () => {
  it('calls orchestrator.approve and returns structured result', async () => {
    const tasks = [makeRunningTask()];
    const approvedTask = makeTask({ status: 'awaiting_approval' });
    const orchestrator = {
      approve: vi.fn().mockResolvedValue(tasks),
      getTask: vi.fn().mockReturnValue(approvedTask),
      resumeTaskAfterFixApproval: vi.fn(),
    };

    const result = await approveTask('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(orchestrator.approve).toHaveBeenCalledWith('task-a');
    expect(result).toEqual({
      approvedTask,
      fixedTask: false,
      started: tasks,
    });
  });

  it('continues post-fix merge approvals through publishAfterFix', async () => {
    const started = [
      makeRunningTask({ id: 'merge-a', config: { workflowId: 'wf-1', isMergeNode: true } }),
    ];
    const orchestrator = {
      approve: vi.fn().mockResolvedValue(started),
      getTask: vi.fn().mockReturnValue(makeTask({
        id: 'merge-a',
        status: 'awaiting_approval',
        config: { workflowId: 'wf-1', isMergeNode: true },
        execution: { pendingFixError: 'fix pending' },
      })),
      resumeTaskAfterFixApproval: vi.fn().mockResolvedValue(started),
    };
    const taskExecutor = {
      commitApprovedFix: vi.fn(),
      publishAfterFix: vi.fn(),
      executeTasks: vi.fn(),
    };

    const result = await approveTask('merge-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(result.fixedTask).toBe(true);
    expect(taskExecutor.commitApprovedFix).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'merge-a' }),
    );
    expect(orchestrator.resumeTaskAfterFixApproval).toHaveBeenCalledWith('merge-a');
    expect(orchestrator.approve).not.toHaveBeenCalled();
    expect(taskExecutor.publishAfterFix).toHaveBeenCalledWith(started[0]);
    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
  });

  it('surfaces corrupt merge-gate fix approvals without recreating the task', async () => {
    const approvedTask = makeTask({
      id: 'merge-a',
      status: 'awaiting_approval',
      config: { workflowId: 'wf-1', isMergeNode: true },
      execution: {
        pendingFixError: 'original gate failure',
        workspacePath: '/tmp/invoker-empty-launch-placeholder',
      },
    });
    const orchestrator = {
      approve: vi.fn(),
      getTask: vi.fn().mockReturnValue(approvedTask),
      resumeTaskAfterFixApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
    const taskExecutor = {
      commitApprovedFix: vi.fn().mockRejectedValue(new Error('git status --porcelain failed (code 128): fatal: not a git repository')),
      publishAfterFix: vi.fn(),
      executeTasks: vi.fn(),
    };

    const result = await approveTask('merge-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(result).toEqual({ approvedTask, fixedTask: true, started: [] });
    expect(orchestrator.revertFixSession).toHaveBeenCalledWith('merge-a', { savedError: 'original gate failure', fixError: expect.stringContaining('Cannot apply a fix because this merge gate\'s saved workspace is missing or is not a git repository: /tmp/invoker-empty-launch-placeholder. This task state is stale or corrupted. Recreate this merge-gate task from a fresh base, then rerun the gate.') });
    expect(orchestrator.resumeTaskAfterFixApproval).not.toHaveBeenCalled();
    expect(orchestrator.approve).not.toHaveBeenCalled();
    expect(taskExecutor.publishAfterFix).not.toHaveBeenCalled();
  });

  it('commits approved fixes and returns non-merge launch claims for the caller to dispatch', async () => {
    const started = [makeRunningTask({ id: 'task-a', config: { workflowId: 'wf-1' } })];
    const approvedTask = makeTask({
      id: 'task-a',
      status: 'awaiting_approval',
      config: { workflowId: 'wf-1' },
      execution: { pendingFixError: 'plain failure', workspacePath: '/tmp/task-a', branch: 'task-a' },
    });
    const orchestrator = {
      approve: vi.fn().mockResolvedValue(started),
      getTask: vi.fn().mockReturnValue(approvedTask),
      resumeTaskAfterFixApproval: vi.fn(),
    };
    const taskExecutor = {
      commitApprovedFix: vi.fn(),
      publishAfterFix: vi.fn(),
      executeTasks: vi.fn(),
    };

    const result = await approveTask('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(result.started).toBe(started);
    expect(taskExecutor.commitApprovedFix).toHaveBeenCalledWith(approvedTask);
    expect(orchestrator.approve).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
    expect(taskExecutor.publishAfterFix).not.toHaveBeenCalled();
  });

  it('commits then returns resumed merge-conflict launch claims for the caller to dispatch', async () => {
    const started = [makeRunningTask({ id: 'task-a', config: { workflowId: 'wf-1' } })];
    const approvedTask = makeTask({
      id: 'task-a',
      status: 'awaiting_approval',
      config: { workflowId: 'wf-1' },
      execution: {
        pendingFixError: JSON.stringify({
          type: 'merge_conflict',
          failedBranch: 'experiment/foo',
          conflictFiles: ['a.ts'],
        }),
        workspacePath: '/tmp/task-a',
        branch: 'task-a',
      },
    });
    const orchestrator = {
      approve: vi.fn(),
      getTask: vi.fn().mockReturnValue(approvedTask),
      resumeTaskAfterFixApproval: vi.fn().mockResolvedValue(started),
    };
    const taskExecutor = {
      commitApprovedFix: vi.fn(),
      publishAfterFix: vi.fn(),
      executeTasks: vi.fn(),
    };

    const result = await approveTask('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(result.started).toBe(started);
    expect(taskExecutor.commitApprovedFix).toHaveBeenCalledWith(approvedTask);
    expect(orchestrator.resumeTaskAfterFixApproval).toHaveBeenCalledWith('task-a');
    expect(orchestrator.approve).not.toHaveBeenCalled();
    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
  });
});

describe('rejectTask', () => {
  let orchestrator: {
    getTask: ReturnType<typeof vi.fn>;
    reject: ReturnType<typeof vi.fn>;
    revertFixSession: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    orchestrator = {
      getTask: vi.fn(() => makeTask({ execution: {} })),
      reject: vi.fn(),
      revertFixSession: vi.fn(),
    };
  });

  it('calls orchestrator.reject when no pendingFixError', () => {
    rejectTask('task-a', { orchestrator: orchestrator as unknown as Orchestrator }, 'bad output');

    expect(orchestrator.reject).toHaveBeenCalledWith('task-a', 'bad output');
    expect(orchestrator.revertFixSession).not.toHaveBeenCalled();
  });

  it('calls orchestrator.revertFixSession when pendingFixError exists', () => {
    orchestrator.getTask.mockReturnValue(
      makeTask({ execution: { pendingFixError: 'merge conflict' } }),
    );

    rejectTask('task-a', { orchestrator: orchestrator as unknown as Orchestrator });

    expect(orchestrator.revertFixSession).toHaveBeenCalledWith('task-a', { savedError: 'merge conflict' });
    expect(orchestrator.reject).not.toHaveBeenCalled();
  });

  it('calls reject without reason when reason is undefined', () => {
    rejectTask('task-a', { orchestrator: orchestrator as unknown as Orchestrator });

    expect(orchestrator.reject).toHaveBeenCalledWith('task-a', undefined);
  });
});

describe('provideInput', () => {
  it('calls orchestrator.provideInput with text', () => {
    const orchestrator = { provideInput: vi.fn() };

    provideInput('task-a', 'hello world', {
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(orchestrator.provideInput).toHaveBeenCalledWith('task-a', 'hello world');
  });
});

describe('finalizeAppliedFix', () => {
  it('leaves task awaiting approval when autoApproveAIFixes is disabled', async () => {
    const orchestrator = {
      setFixAwaitingApproval: vi.fn(),
      approve: vi.fn(),
    };
    const taskExecutor = {
      commitApprovedFix: vi.fn(),
      publishAfterFix: vi.fn(),
      executeTasks: vi.fn(),
    };

    const result = await finalizeAppliedFix('task-a', 'saved-error', {
      orchestrator: orchestrator as unknown as Orchestrator,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      autoApproveAIFixes: false,
    });

    expect(result).toEqual({ autoApproved: false, started: [] });
    expect(orchestrator.setFixAwaitingApproval).toHaveBeenCalledWith('task-a', 'saved-error');
    expect(orchestrator.approve).not.toHaveBeenCalled();
  });

  it('auto-approves and returns runnable tasks when enabled', async () => {
    const started = [
      makeRunningTask({ id: 'task-a', config: { workflowId: 'wf-1' } }),
    ];
    const orchestrator = {
      setFixAwaitingApproval: vi.fn(),
      approve: vi.fn().mockResolvedValue(started),
      getTask: vi.fn().mockReturnValue(makeTask({
        id: 'task-a',
        status: 'awaiting_approval',
        config: { workflowId: 'wf-1' },
        execution: { pendingFixError: 'saved-error', workspacePath: '/tmp/task-a', branch: 'task-a' },
      })),
    };
    const taskExecutor = {
      commitApprovedFix: vi.fn(),
      publishAfterFix: vi.fn(),
      executeTasks: vi.fn(),
    };

    const result = await finalizeAppliedFix('task-a', 'saved-error', {
      orchestrator: orchestrator as unknown as Orchestrator,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      autoApproveAIFixes: true,
    });

    expect(result).toEqual({ autoApproved: true, started });
    expect(orchestrator.approve).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.commitApprovedFix).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-a' }),
    );
    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
    expect(taskExecutor.publishAfterFix).not.toHaveBeenCalled();
  });

  it('auto-approves and publishes post-fix merge gates when enabled', async () => {
    const started = [
      makeRunningTask({ id: 'merge-a', config: { workflowId: 'wf-1', isMergeNode: true } }),
    ];
    const orchestrator = {
      setFixAwaitingApproval: vi.fn(),
      approve: vi.fn().mockResolvedValue(started),
      getTask: vi.fn().mockReturnValue(makeTask({
        id: 'merge-a',
        status: 'awaiting_approval',
        config: { workflowId: 'wf-1', isMergeNode: true },
        execution: { pendingFixError: 'saved-error', workspacePath: '/tmp/merge-a' },
      })),
      resumeTaskAfterFixApproval: vi.fn().mockResolvedValue(started),
    };
    const taskExecutor = {
      commitApprovedFix: vi.fn(),
      publishAfterFix: vi.fn(),
      executeTasks: vi.fn(),
    };

    await finalizeAppliedFix('merge-a', 'saved-error', {
      orchestrator: orchestrator as unknown as Orchestrator,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      autoApproveAIFixes: true,
    });

    expect(taskExecutor.commitApprovedFix).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'merge-a' }),
    );
    expect(taskExecutor.publishAfterFix).toHaveBeenCalledWith(started[0]);
    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
  });
});

describe('autoFixOnFailure', () => {
  it('routes startup merge conflicts without a workspace to workflow fresh-base recreate', async () => {
    const started = [
      makeRunningTask({ id: 'task-a', status: 'running', config: { workflowId: 'wf-1' } }),
    ];
    const mergeError = JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'experiment/foo',
      conflictFiles: ['src/foo.ts'],
    });
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: { error: mergeError },
      })),
      beginFixSession: vi.fn(() => ({ savedError: mergeError })),
      recreateWorkflowFromFreshBase: vi.fn(async (_workflowId: string, options?: { refreshBase?: () => Promise<unknown> }) => {
        await options?.refreshBase?.();
        return started;
      }),
      cancelWorkflow: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      cascadeInvalidationToDownstream: vi.fn(() => []),
      retryTask: vi.fn(() => []),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
      loadWorkflow: vi.fn(() => ({
        id: 'wf-1',
        generation: 1,
        repoUrl: 'https://example/repo.git',
        baseBranch: 'master',
      })),
      updateWorkflow: vi.fn(),
      logEvent: vi.fn(),
    };
    const taskExecutor = {
      preparePoolForRebaseRetry: vi.fn().mockResolvedValue(undefined),
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn().mockResolvedValue(undefined),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    await autoFixOnFailure('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    });

    expect(orchestrator.beginFixSession).not.toHaveBeenCalled();
    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith(
      'wf-1',
      expect.objectContaining({ refreshBase: expect.any(Function) }),
    );
    expect(taskExecutor.preparePoolForRebaseRetry).toHaveBeenCalledWith(
      'wf-1',
      'https://example/repo.git',
      'master',
    );
    expect(taskExecutor.resolveConflict).not.toHaveBeenCalled();
    expect(taskExecutor.fixWithAgent).not.toHaveBeenCalled();
    expect(taskExecutor.executeTasks).toHaveBeenCalledWith(started);
  });

  it('uses fixWithAgent for non-merge failures and restarts the task directly', async () => {
    const started = [makeRunningTask({ id: 'task-a', status: 'running' })];
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        execution: { error: 'boom', workspacePath: '/tmp/task-a' },
      })),
      beginFixSession: vi.fn(() => ({ savedError: 'boom' })),
      retryTask: vi.fn(() => started),
      cancelTask: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      cascadeInvalidationToDownstream: vi.fn(() => []),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn(),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    await autoFixOnFailure('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    });

    expect(orchestrator.beginFixSession).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.fixWithAgent).toHaveBeenCalledWith('task-a', 'test output', 'codex', 'boom');
    expect(taskExecutor.resolveConflict).not.toHaveBeenCalled();
    expect(orchestrator.retryTask).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.executeTasks).toHaveBeenCalledWith(started);
  });

  it('skips auto-fix when workspacePath is missing for non-recreate routes', async () => {
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        execution: { error: 'boom' },
      })),
      beginFixSession: vi.fn(() => ({ savedError: 'boom' })),
      retryTask: vi.fn(() => []),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
      logEvent: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn().mockResolvedValue(undefined),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    await autoFixOnFailure('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    });

    expect(orchestrator.beginFixSession).not.toHaveBeenCalled();
    expect(taskExecutor.fixWithAgent).not.toHaveBeenCalled();
    expect(taskExecutor.resolveConflict).not.toHaveBeenCalled();
    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
    expect(orchestrator.retryTask).not.toHaveBeenCalled();
    expect(persistence.logEvent).toHaveBeenCalledWith(
      'task-a',
      'debug.auto-fix',
      expect.objectContaining({
        phase: 'auto-fix-skip-no-workspace',
        route: 'fixWithAgent',
      }),
    );
    expect(persistence.appendTaskOutput).toHaveBeenCalledWith(
      'task-a',
      expect.stringContaining('[Auto-fix] Auto-fix skipped: task "task-a" has no valid workspacePath'),
    );
  });

  it('uses resolveConflict for merge-conflict errors and restarts the task directly', async () => {
    const started = [makeRunningTask({ id: 'task-a', status: 'running' })];
    const mergeError = JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'experiment/foo',
      conflictFiles: ['src/foo.ts'],
    });
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        execution: { error: mergeError, workspacePath: '/tmp/task-a' },
      })),
      beginFixSession: vi.fn(() => ({ savedError: mergeError })),
      retryTask: vi.fn(() => started),
      cancelTask: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      cascadeInvalidationToDownstream: vi.fn(() => []),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn().mockResolvedValue(undefined),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    await autoFixOnFailure('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    });

    expect(orchestrator.beginFixSession).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith('task-a', mergeError, 'codex', undefined);
    expect(taskExecutor.fixWithAgent).not.toHaveBeenCalled();
    expect(orchestrator.retryTask).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.executeTasks).toHaveBeenCalledWith(started);
  });

  it('prefers conflictResolutionAgent over autoFixAgent for merge conflicts', async () => {
    loadConfigMock.mockReturnValue({
      conflictResolutionAgent: 'omp',
      conflictResolutionModel: 'gpt-5-mini',
    });
    const started = [makeRunningTask({ id: 'task-a', status: 'running' })];
    const mergeError = JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'experiment/foo',
      conflictFiles: ['src/foo.ts'],
    });
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        execution: { error: mergeError, workspacePath: '/tmp/task-a' },
      })),
      beginFixSession: vi.fn(() => ({ savedError: mergeError })),
      retryTask: vi.fn(() => started),
      cancelTask: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      cascadeInvalidationToDownstream: vi.fn(() => []),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn().mockResolvedValue(undefined),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    await autoFixOnFailure('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
      getAutoFixAgent: () => 'claude',
    });

    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith(
      'task-a',
      mergeError,
      'omp',
      'gpt-5-mini',
    );
    expect(taskExecutor.fixWithAgent).not.toHaveBeenCalled();
  });

  it('uses resolveConflict for prefixed post-fix merge conflict errors', async () => {
    const started = [makeRunningTask({ id: 'task-a', status: 'running' })];
    const mergeError = `Post-fix PR prep failed: ${JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'experiment/foo',
      conflictFiles: ['src/foo.ts'],
    })}`;
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        execution: { error: mergeError, workspacePath: '/tmp/task-a' },
      })),
      beginFixSession: vi.fn(() => ({ savedError: mergeError })),
      retryTask: vi.fn(() => started),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn().mockResolvedValue(undefined),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    await autoFixOnFailure('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    });

    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith('task-a', mergeError, 'codex', undefined);
    expect(taskExecutor.fixWithAgent).not.toHaveBeenCalled();
  });

  it('records fixed integration anchor and routes merge gates to finalize/publish flow', async () => {
    const started = [
      makeRunningTask({ id: 'merge-a', config: { workflowId: 'wf-1', isMergeNode: true } }),
    ];
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        id: 'merge-a',
        status: 'failed',
        config: { workflowId: 'wf-1', isMergeNode: true },
        execution: { workspacePath: '/tmp/merge-a' },
      })),
      beginFixSession: vi.fn(() => ({ savedError: 'boom' })),
      retryTask: vi.fn(() => []),
      setFixAwaitingApproval: vi.fn(),
      approve: vi.fn().mockResolvedValue(started),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
      logEvent: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn(),
      execGitIn: vi.fn().mockResolvedValue('abc123'),
      publishAfterFix: vi.fn().mockResolvedValue(undefined),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    await autoFixOnFailure('merge-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
      getAutoApproveAIFixes: () => true,
    });

    expect(taskExecutor.execGitIn).toHaveBeenCalledWith(['rev-parse', 'HEAD'], '/tmp/merge-a');
    expect(persistence.updateTask).toHaveBeenCalledWith(
      'merge-a',
      expect.objectContaining({
        execution: expect.objectContaining({
          fixedIntegrationSha: 'abc123',
          fixedIntegrationSource: 'auto_fix',
        }),
      }),
    );
    expect(orchestrator.retryTask).not.toHaveBeenCalled();
    expect(taskExecutor.publishAfterFix).toHaveBeenCalledWith(started[0]);
  });

  it('retries inline when merge post-fix publish fails during auto-fix dispatch', async () => {
    const started = [
      makeRunningTask({ id: 'merge-a', config: { workflowId: 'wf-1', isMergeNode: true } }),
    ];
    // The getTask mock is driven by a state machine that tracks which
    // phase the auto-fix flow is in.  Each phase may call getTask
    // multiple times (entry check, lineage capture, lineage assert,
    // approveTask, post-finalize).  We use a phase counter that
    // advances at known transition points (beginFixSession
    // and setFixAwaitingApproval) to keep return values consistent.
    let phase = 0;
    const phases: Record<string, unknown>[] = [
      // Phase 0: entry check + lineage capture (cycle 1)
      { status: 'failed', execution: { workspacePath: '/tmp/merge-a', selectedAttemptId: 'att-1', generation: 1 } },
      // Phase 1: after fix returns, lineage check + finalize + approveTask (cycle 1)
      { status: 'awaiting_approval', execution: { workspacePath: '/tmp/merge-a', pendingFixError: 'boom', selectedAttemptId: 'att-1', generation: 1 } },
      // Phase 2: post-finalize check — task re-failed after publish
      { status: 'failed', execution: { workspacePath: '/tmp/merge-a', error: 'Post-fix PR prep failed: conflict', selectedAttemptId: 'att-1', generation: 1 } },
      // Phase 3: inline retry entry + lineage capture (cycle 2)
      { status: 'failed', execution: { workspacePath: '/tmp/merge-a', selectedAttemptId: 'att-3', generation: 3 } },
      // Phase 4: after fix returns, lineage check + finalize + approveTask (cycle 2)
      { status: 'awaiting_approval', execution: { workspacePath: '/tmp/merge-a', pendingFixError: 'boom', selectedAttemptId: 'att-3', generation: 3 } },
    ];
    const getTask = vi.fn(() => {
      const idx = Math.min(phase, phases.length - 1);
      return makeTask({
        id: 'merge-a',
        config: { workflowId: 'wf-1', isMergeNode: true },
        ...phases[idx],
      });
    });
    // Advance phase at key transition points
    const origBeginFixSession = vi.fn(() => {
      phase++;
      return { savedError: 'boom' };
    });
    const origSetFixAwaitingApproval = vi.fn(() => { phase++; });
    const orchestrator = {
      getTask,
      beginFixSession: origBeginFixSession,
      retryTask: vi.fn(() => []),
      setFixAwaitingApproval: origSetFixAwaitingApproval,
      approve: vi.fn().mockResolvedValue(started),
      resumeTaskAfterFixApproval: vi.fn().mockResolvedValue(started),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
      logEvent: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn(),
      commitApprovedFix: vi.fn().mockResolvedValue(undefined),
      execGitIn: vi.fn().mockResolvedValue('abc123'),
      publishAfterFix: vi
        .fn()
        .mockImplementationOnce(async () => undefined)
        .mockImplementationOnce(async () => undefined),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    await autoFixOnFailure('merge-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
      getAutoApproveAIFixes: () => true,
    });

    expect(taskExecutor.fixWithAgent).toHaveBeenCalledTimes(2);
    expect(taskExecutor.execGitIn).toHaveBeenCalledTimes(2);
    expect(taskExecutor.publishAfterFix).toHaveBeenCalledTimes(2);
    expect(persistence.logEvent).toHaveBeenCalledWith(
      'merge-a',
      'debug.auto-fix',
      expect.objectContaining({
        phase: 'auto-fix-post-route-inline-retry',
      }),
    );
    expect(orchestrator.retryTask).not.toHaveBeenCalled();
  });

  it('prefers config.autoFixAgent over task executionAgent', async () => {
    const started = [makeRunningTask({ id: 'task-a', status: 'running' })];
    const logEvent = vi.fn();
    const appendTaskOutput = vi.fn();
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1', executionAgent: 'claude' },
        execution: { workspacePath: '/tmp/task-a' },
      })),
      beginFixSession: vi.fn(() => ({ savedError: 'boom' })),
      retryTask: vi.fn(() => started),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput,
      logEvent,
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn(),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    await autoFixOnFailure('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
      getAutoFixAgent: () => 'codex',
    });

    expect(taskExecutor.fixWithAgent).toHaveBeenCalledWith('task-a', 'test output', 'codex', 'boom');
    expect(logEvent).toHaveBeenCalledWith(
      'task-a',
      'debug.auto-fix',
      expect.objectContaining({
        phase: 'auto-fix-agent-selected',
        selectedAgent: 'codex',
        selectedAgentSource: 'config',
      }),
    );
    expect(appendTaskOutput).toHaveBeenCalledWith(
      'task-a',
      expect.stringContaining('[Auto-fix Agent] selected=codex source=config'),
    );
  });

  it('ignores task executionAgent when config.autoFixAgent is empty and uses default agent', async () => {
    const started = [makeRunningTask({ id: 'task-a', status: 'running' })];
    const logEvent = vi.fn();
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1', executionAgent: 'codex' },
        execution: { workspacePath: '/tmp/task-a' },
      })),
      beginFixSession: vi.fn(() => ({ savedError: 'boom' })),
      retryTask: vi.fn(() => started),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
      logEvent,
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn(),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    await autoFixOnFailure('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
      getAutoFixAgent: () => '   ',
    });

    expect(taskExecutor.fixWithAgent).toHaveBeenCalledWith('task-a', 'test output', 'codex', 'boom');
    expect(logEvent).toHaveBeenCalledWith(
      'task-a',
      'debug.auto-fix',
      expect.objectContaining({
        phase: 'auto-fix-agent-selected',
        selectedAgent: 'codex',
        selectedAgentSource: 'default',
      }),
    );
  });

  it('falls back to built-in default agent when config and task agent are missing', async () => {
    const started = [makeRunningTask({ id: 'task-a', status: 'running' })];
    const mergeError = JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'experiment/foo',
      conflictFiles: ['src/foo.ts'],
    });
    const logEvent = vi.fn();
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: { error: mergeError, workspacePath: '/tmp/task-a' },
      })),
      beginFixSession: vi.fn(() => ({ savedError: mergeError })),
      retryTask: vi.fn(() => started),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
      logEvent,
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn().mockResolvedValue(undefined),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    await autoFixOnFailure('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
      getAutoFixAgent: () => undefined,
    });

    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith('task-a', mergeError, 'codex', undefined);
    expect(logEvent).toHaveBeenCalledWith(
      'task-a',
      'debug.auto-fix',
      expect.objectContaining({
        phase: 'auto-fix-agent-selected',
        selectedAgent: 'codex',
        selectedAgentSource: 'default',
      }),
    );
  });
});

describe('selectFailureRecoveryRoute', () => {
  it('treats executor startup merge-conflict text as a merge conflict', () => {
    const route = selectFailureRecoveryRoute(
      makeTask({
        config: { workflowId: 'wf-1' },
        execution: {},
      }) as any,
      'Executor startup failed (ssh): Merge conflict merging experiment/foo: packages/workflow-core/src/orchestrator.ts',
    );

    expect(route).toEqual({ kind: 'recreateWorkflowFromFreshBase', workflowId: 'wf-1' });
  });

  it('uses workflow fresh-base recreate for startup merge conflicts without a workspace', () => {
    const route = selectFailureRecoveryRoute(
      makeTask({
        config: { workflowId: 'wf-1' },
        execution: {},
      }) as any,
      JSON.stringify({
        type: 'merge_conflict',
        failedBranch: 'experiment/foo',
        conflictFiles: ['src/foo.ts'],
      }),
    );

    expect(route).toEqual({ kind: 'recreateWorkflowFromFreshBase', workflowId: 'wf-1' });
  });

  it('uses resolveConflict for merge conflicts when a workspace exists', () => {
    const route = selectFailureRecoveryRoute(
      makeTask({
        config: { workflowId: 'wf-1' },
        execution: { workspacePath: '/tmp/task-a' },
      }) as any,
      JSON.stringify({
        type: 'merge_conflict',
        failedBranch: 'experiment/foo',
        conflictFiles: ['src/foo.ts'],
      }),
    );

    expect(route).toEqual({ kind: 'resolveConflict' });
  });

  it('uses resolveConflict for parseable text merge conflicts when a workspace exists', () => {
    const route = selectFailureRecoveryRoute(
      makeTask({
        config: { workflowId: 'wf-1' },
        execution: { workspacePath: '/tmp/task-a' },
      }) as any,
      'Executor startup failed (ssh): Merge conflict merging experiment/foo: packages/app/src/headless.ts',
    );

    expect(route).toEqual({ kind: 'resolveConflict' });
  });

  it('uses fixWithAgent for conflict-looking text without recoverable metadata', () => {
    const route = selectFailureRecoveryRoute(
      makeTask({
        config: { workflowId: 'wf-1' },
        execution: { workspacePath: '/tmp/task-a' },
      }) as any,
      'CONFLICT (content): Merge conflict in src/foo.ts\nAutomatic merge failed; fix conflicts and commit.',
    );

    expect(route).toEqual({ kind: 'fixWithAgent' });
  });

  it('uses fixWithAgent for non-merge failures', () => {
    const route = selectFailureRecoveryRoute(
      makeTask({
        config: { workflowId: 'wf-1' },
        execution: {},
      }) as any,
      'boom',
    );

    expect(route).toEqual({ kind: 'fixWithAgent' });
  });
});

describe('fixWithAgentAction', () => {
  it('dispatches plain failures to taskExecutor.fixWithAgent', async () => {
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: { error: 'boom', workspacePath: '/tmp/task-a' },
      })),
      beginFixSession: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn(),
    };

    const result = await fixWithAgentAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    }, {
      agentName: 'codex',
    });

    expect(taskExecutor.fixWithAgent).toHaveBeenCalledWith('task-a', 'test output', 'codex', 'boom');
    expect(taskExecutor.resolveConflict).not.toHaveBeenCalled();
    expect(orchestrator.setFixAwaitingApproval).toHaveBeenCalledWith('task-a', 'boom');
    expect(result).toEqual({ kind: 'fixWithAgent', autoApproved: false, started: [] });
  });
  it('rejects plain fixes without a saved workspace before fix execution', async () => {
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: { error: 'boom' },
      })),
      beginFixSession: vi.fn(),
      setFixAwaitingApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      getDefaultExecutionAgent: vi.fn(() => 'codex'),
      execGitIn: vi.fn(),
      fixWithAgent: vi.fn(),
      resolveConflict: vi.fn(),
    };

    await expect(fixWithAgentAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    })).rejects.toThrow('Cannot apply a fix because this task has no saved workspace');

    expect(taskExecutor.execGitIn).not.toHaveBeenCalled();
    expect(taskExecutor.fixWithAgent).not.toHaveBeenCalled();
    expect(taskExecutor.resolveConflict).not.toHaveBeenCalled();
    expect(orchestrator.beginFixSession).not.toHaveBeenCalled();
    expect(orchestrator.setFixAwaitingApproval).not.toHaveBeenCalled();
    expect(persistence.appendTaskOutput).toHaveBeenCalledWith(
      'task-a',
      '\n[Fix with codex] Cannot apply a fix because this task has no saved workspace. This task state is stale or corrupted. Recreate the task or recreate the workflow, then rerun it.',
    );
    expect(orchestrator.revertFixSession).toHaveBeenCalledWith('task-a', {
      savedError: 'boom',
      fixError: 'Cannot apply a fix because this task has no saved workspace. This task state is stale or corrupted. Recreate the task or recreate the workflow, then rerun it.',
    });
  });

  it('uses the task runner default agent when manual fix omits agentName', async () => {
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: { error: 'boom', workspacePath: '/tmp/task-a' },
      })),
      beginFixSession: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      getDefaultExecutionAgent: vi.fn(() => 'custom-agent'),
      fixWithAgent: vi.fn().mockRejectedValue(new Error('agent failed')),
      resolveConflict: vi.fn(),
    };

    await expect(fixWithAgentAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    })).rejects.toThrow('agent failed');

    expect(taskExecutor.fixWithAgent).toHaveBeenCalledWith('task-a', 'test output', 'custom-agent', 'boom');
    expect(persistence.appendTaskOutput).toHaveBeenCalledWith(
      'task-a',
      '\n[Fix with custom-agent] Failed: agent failed',
    );
    expect(orchestrator.revertFixSession).toHaveBeenCalledWith('task-a', { savedError: 'boom', fixError: 'agent failed' });
  });

  it('dispatches merge conflicts with a workspace to taskExecutor.resolveConflict', async () => {
    const mergeError = JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'experiment/foo',
      conflictFiles: ['src/foo.ts'],
    });
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: { error: mergeError, workspacePath: '/tmp/task-a' },
      })),
      beginFixSession: vi.fn(() => ({ savedError: mergeError })),
      setFixAwaitingApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      getTaskOutput: vi.fn(),
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn(),
      resolveConflict: vi.fn().mockResolvedValue(undefined),
    };

    const result = await fixWithAgentAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    }, {
      agentName: 'claude',
    });

    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith('task-a', mergeError, 'claude', undefined);
    expect(taskExecutor.fixWithAgent).not.toHaveBeenCalled();
    expect(orchestrator.setFixAwaitingApproval).toHaveBeenCalledWith('task-a', mergeError);
    expect(result).toEqual({ kind: 'resolveConflict', autoApproved: false, started: [] });
  });

  it('dispatches text merge conflicts with a stale workspace to taskExecutor.resolveConflict', async () => {
    const mergeError = 'Executor startup failed (ssh): Merge conflict merging experiment/foo: packages/app/src/headless.ts';
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: { error: mergeError, workspacePath: '/tmp/stale-task-a' },
      })),
      beginFixSession: vi.fn(() => ({ savedError: mergeError })),
      setFixAwaitingApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      getTaskOutput: vi.fn(),
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn(),
      resolveConflict: vi.fn().mockResolvedValue(undefined),
    };

    const result = await fixWithAgentAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    }, {
      agentName: 'codex',
    });

    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith('task-a', mergeError, 'codex', undefined);
    expect(taskExecutor.fixWithAgent).not.toHaveBeenCalled();
    expect(orchestrator.setFixAwaitingApproval).toHaveBeenCalledWith('task-a', mergeError);
    expect(result).toEqual({ kind: 'resolveConflict', autoApproved: false, started: [] });
  });

  it('dispatches startup merge conflicts without a workspace to workflow recreate', async () => {
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: {
          error: 'Executor startup failed (ssh): Merge conflict merging experiment/foo: packages/workflow-core/src/orchestrator.ts',
        },
      })),
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 2 })),
      updateWorkflow: vi.fn(),
      cancelWorkflow: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      recreateWorkflowFromFreshBase: vi.fn(async () => [makeRunningTask({ id: 'task-a', status: 'running' })]),
      cascadeInvalidationToDownstream: vi.fn(() => []),
    };
    const persistence = {
      appendTaskOutput: vi.fn(),
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 2 })),
      updateWorkflow: vi.fn(),
      logEvent: vi.fn(),
    };
    const taskExecutor = {
      preparePoolForRebaseRetry: vi.fn().mockResolvedValue(undefined),
    };

    const result = await fixWithAgentAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    }, {
      recreateOutputLabel: 'Fix with AI',
    });

    expect(persistence.appendTaskOutput).toHaveBeenCalledWith(
      'task-a',
      expect.stringContaining('Startup merge conflict detected; recreating workflow wf-1 from a fresh base.'),
    );
    expect(persistence.logEvent).toHaveBeenCalledWith(
      'task-a',
      'task.workflow_recreated',
      expect.objectContaining({
        level: 'warn',
        workflowId: 'wf-1',
        reason: 'missing-workspace-startup-merge-conflict',
        message: 'Workspace was missing, so Invoker recreated workflow wf-1 from a fresh base instead of fixing this task in-place.',
      }),
    );
    expect(persistence.updateWorkflow).not.toHaveBeenCalled();
    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith('wf-1', expect.any(Object));
    expect(result).toEqual({
      kind: 'recreateWorkflowFromFreshBase',
      workflowId: 'wf-1',
      started: [expect.objectContaining({ id: 'task-a', status: 'running' })],
    });
  });

  it('fixWithAgentAction rejects invalid merge-gate workspaces before fix execution', async () => {
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        id: 'merge-a',
        status: 'failed',
        config: { workflowId: 'wf-1', isMergeNode: true },
        execution: {
          error: 'Unable to resolve merge worktree ref "plan/old-base"',
          workspacePath: '/tmp/invoker-empty-launch-placeholder',
        },
      })),
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 2 })),
      updateWorkflow: vi.fn(),
      cancelWorkflow: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      recreateWorkflowFromFreshBase: vi.fn(async () => [makeRunningTask({ id: 'merge-a', status: 'running' })]),
      cascadeInvalidationToDownstream: vi.fn(() => []),
      beginFixSession: vi.fn(),
      setFixAwaitingApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      appendTaskOutput: vi.fn(),
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 2 })),
      updateWorkflow: vi.fn(),
      getTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      getDefaultExecutionAgent: vi.fn(() => 'claude'),
      preparePoolForRebaseRetry: vi.fn().mockResolvedValue(undefined),
      execGitIn: vi.fn().mockRejectedValue(new Error('fatal: not a git repository')),
      fixWithAgent: vi.fn(),
      resolveConflict: vi.fn(),
    };

    await expect(fixWithAgentAction('merge-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    }, {
      agentName: 'Codex',
    })).rejects.toThrow('Cannot apply a fix because this merge gate\'s saved workspace is missing or is not a git repository');

    expect(taskExecutor.execGitIn).toHaveBeenCalledWith(
      ['rev-parse', '--is-inside-work-tree'],
      '/tmp/invoker-empty-launch-placeholder',
    );
    expect(taskExecutor.fixWithAgent).not.toHaveBeenCalled();
    expect(taskExecutor.resolveConflict).not.toHaveBeenCalled();
    expect(orchestrator.beginFixSession).not.toHaveBeenCalled();
    expect(orchestrator.setFixAwaitingApproval).not.toHaveBeenCalled();
    expect(persistence.appendTaskOutput).toHaveBeenCalledWith(
      'merge-a',
      expect.stringContaining('\n[Fix with Codex] Cannot apply a fix because this merge gate\'s saved workspace is missing or is not a git repository: /tmp/invoker-empty-launch-placeholder. This task state is stale or corrupted. Recreate this merge-gate task from a fresh base, then rerun the gate.'),
    );
    expect(orchestrator.revertFixSession).toHaveBeenCalledWith('merge-a', { savedError: 'Unable to resolve merge worktree ref "plan/old-base"', fixError: expect.stringContaining('Cannot apply a fix because this merge gate\'s saved workspace is missing or is not a git repository: /tmp/invoker-empty-launch-placeholder. This task state is stale or corrupted. Recreate this merge-gate task from a fresh base, then rerun the gate.') });
    expect(orchestrator.recreateWorkflowFromFreshBase).not.toHaveBeenCalled();
  });
});

describe('editTaskCommand', () => {
  it('calls orchestrator.editTaskCommand and returns result', () => {
    const tasks = [makeRunningTask()];
    const orchestrator = { editTaskCommand: vi.fn(() => tasks) };

    const result = editTaskCommand('task-a', 'npm test', {
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(orchestrator.editTaskCommand).toHaveBeenCalledWith('task-a', 'npm test');
    expect(result).toBe(tasks);
  });
});

describe('editTaskPrompt', () => {
  it('calls orchestrator.editTaskPrompt and returns result', () => {
    const tasks = [makeRunningTask()];
    const orchestrator = { editTaskPrompt: vi.fn(() => tasks) };

    const result = editTaskPrompt('task-a', 'Implement the auth module', {
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(orchestrator.editTaskPrompt).toHaveBeenCalledWith('task-a', 'Implement the auth module');
    expect(result).toBe(tasks);
  });

  it('routes through editTaskPrompt not editTaskCommand', () => {
    const orchestrator = {
      editTaskPrompt: vi.fn(() => []),
      editTaskCommand: vi.fn(() => []),
    };

    editTaskPrompt('task-a', 'new prompt', {
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(orchestrator.editTaskPrompt).toHaveBeenCalledWith('task-a', 'new prompt');
    expect(orchestrator.editTaskCommand).not.toHaveBeenCalled();
  });
});


describe('selectExperiment', () => {
  it('calls orchestrator.selectExperiment and returns result', () => {
    const tasks = [makeRunningTask()];
    const orchestrator = { selectExperiment: vi.fn(() => tasks) };

    const result = selectExperiment('task-a', 'exp-1', {
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(orchestrator.selectExperiment).toHaveBeenCalledWith('task-a', 'exp-1');
    expect(result).toBe(tasks);
  });
});

describe('setWorkflowMergeMode', () => {
  // These tests pin the wrapper's two branches:
  //   - merge node present  -> `orchestrator.editTaskMergeMode`
  //   - merge node absent   -> direct `persistence.updateWorkflow`
  let orchestrator: { editTaskMergeMode: ReturnType<typeof vi.fn> };
  let persistence: {
    updateWorkflow: ReturnType<typeof vi.fn>;
    loadTasks: ReturnType<typeof vi.fn>;
  };
  let taskExecutor: { executeTasks: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    orchestrator = {
      editTaskMergeMode: vi.fn(() => [makeRunningTask({ id: 'merge-task', config: { isMergeNode: true } })]),
    };
    persistence = {
      updateWorkflow: vi.fn(),
      loadTasks: vi.fn(() => [
        makeTask({ id: 'task-a', status: 'completed' }),
        makeTask({ id: 'merge-task', status: 'completed', config: { isMergeNode: true } }),
      ]),
    };
    taskExecutor = {
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('routes through orchestrator.editTaskMergeMode with the canonical mode when a merge node exists', async () => {
    await setWorkflowMergeMode('wf-1', 'external_review', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(orchestrator.editTaskMergeMode).toHaveBeenCalledWith('merge-task', 'external_review');
    // Workflow-record write happens INSIDE the orchestrator seam
    // when a merge node exists — the wrapper MUST NOT double-write.
    expect(persistence.updateWorkflow).not.toHaveBeenCalled();
  });

  it('executes runnable tasks returned by the orchestrator', async () => {
    await setWorkflowMergeMode('wf-1', 'automatic', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(orchestrator.editTaskMergeMode).toHaveBeenCalledWith('merge-task', 'automatic');
    expect(taskExecutor.executeTasks).toHaveBeenCalled();
  });

  it('does not execute when the orchestrator returns no runnable tasks (e.g. same-mode no-op)', async () => {
    orchestrator.editTaskMergeMode.mockReturnValueOnce([]);

    await setWorkflowMergeMode('wf-1', 'manual', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(orchestrator.editTaskMergeMode).toHaveBeenCalledWith('merge-task', 'manual');
    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
  });

  it('falls back to a direct persistence write when no merge node exists (no-merge-gate workflow)', async () => {
    persistence.loadTasks.mockReturnValue([makeTask({ id: 'task-a', status: 'completed' })]);

    await setWorkflowMergeMode('wf-1', 'manual', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(orchestrator.editTaskMergeMode).not.toHaveBeenCalled();
    expect(persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', { mergeMode: 'manual' });
    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
  });

  it('throws on invalid merge mode', async () => {
    await expect(
      setWorkflowMergeMode('wf-1', 'invalid', {
        orchestrator: orchestrator as unknown as Orchestrator,
        persistence: persistence as unknown as SQLiteAdapter,
        taskExecutor: taskExecutor as unknown as TaskRunner,
      }),
    ).rejects.toThrow('Invalid mergeMode');
  });
});

// ── Invalidation routing scaffolding (Phase A, Step 1) ───────

describe('buildCancelInFlight', () => {
  it('cancels task before awaiting killActiveExecution for each runningCancelled id', async () => {
    const orchestrator = {
      cancelTask: vi.fn(() => ({ cancelled: ['task-a'], runningCancelled: ['task-a'] })),
      cancelWorkflow: vi.fn(),
    };
    const taskExecutor = {
      killActiveExecution: vi.fn().mockResolvedValue(undefined),
    };

    const cancel = buildCancelInFlight({
      orchestrator: orchestrator as unknown as Orchestrator,
      killActiveExecution: taskExecutor.killActiveExecution,
    });
    await cancel('task', 'task-a');

    expect(orchestrator.cancelTask).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.killActiveExecution).toHaveBeenCalledWith('task-a');
    expect(orchestrator.cancelTask.mock.invocationCallOrder[0]).toBeLessThan(
      taskExecutor.killActiveExecution.mock.invocationCallOrder[0],
    );
    expect(orchestrator.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('cancels workflow before awaiting killActiveExecution per runningCancelled id', async () => {
    const orchestrator = {
      cancelTask: vi.fn(),
      cancelWorkflow: vi.fn(() => ({
        cancelled: ['task-a', 'task-b'],
        runningCancelled: ['task-a', 'task-b'],
      })),
    };
    const taskExecutor = {
      killActiveExecution: vi.fn().mockResolvedValue(undefined),
    };

    const cancel = buildCancelInFlight({
      orchestrator: orchestrator as unknown as Orchestrator,
      killActiveExecution: taskExecutor.killActiveExecution,
    });
    await cancel('workflow', 'wf-1');

    expect(orchestrator.cancelWorkflow).toHaveBeenCalledWith('wf-1');
    expect(taskExecutor.killActiveExecution).toHaveBeenNthCalledWith(1, 'task-a');
    expect(taskExecutor.killActiveExecution).toHaveBeenNthCalledWith(2, 'task-b');
    expect(orchestrator.cancelTask).not.toHaveBeenCalled();
  });

  it('is a no-op when scope is none', async () => {
    const orchestrator = { cancelTask: vi.fn(), cancelWorkflow: vi.fn() };
    const taskExecutor = { killActiveExecution: vi.fn() };

    const cancel = buildCancelInFlight({
      orchestrator: orchestrator as unknown as Orchestrator,
      killActiveExecution: taskExecutor.killActiveExecution,
    });
    await cancel('none', 'whatever');

    expect(orchestrator.cancelTask).not.toHaveBeenCalled();
    expect(orchestrator.cancelWorkflow).not.toHaveBeenCalled();
    expect(taskExecutor.killActiveExecution).not.toHaveBeenCalled();
  });
});

describe('buildWorkflowInvalidationDeps', () => {
  function makeBaseOrchestrator() {
    return {
      retryTask: vi.fn(() => [makeRunningTask({ id: 'task-a' })]),
      recreateTask: vi.fn(() => [makeRunningTask({ id: 'task-a' })]),
      recreateDownstream: vi.fn(() => [makeRunningTask({ id: 'task-b' })]),
      retryWorkflow: vi.fn(() => [makeRunningTask({ id: 'task-a' })]),
      recreateWorkflow: vi.fn(() => [makeRunningTask({ id: 'task-a' })]),
      cancelTask: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      cancelWorkflow: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      autoStartExternallyUnblockedReadyTasks: vi.fn(() => [makeRunningTask({ id: 'task-c' })]),
      approve: vi.fn(async () => [makeRunningTask({ id: 'task-a' })]),
      reject: vi.fn(),
      getTask: vi.fn(() => ({ id: 'task-a', config: { workflowId: 'wf-1' }, execution: {} })),
      forkWorkflow: vi.fn((workflowId: string) => ({
        sourceWorkflowId: workflowId,
        forkedWorkflowId: `${workflowId}-fork`,
        started: [makeRunningTask({ id: `${workflowId}-fork/task-a`, config: { workflowId: `${workflowId}-fork` } as any })],
      })),
      cascadeInvalidationToDownstream: vi.fn(() => [makeRunningTask({ id: 'wf-2/leaf' })]),
      recreateWorkflowFromFreshBase: vi.fn(async (_id: string, options?: any) => {
        await options?.refreshBase?.(_id);
        return [makeRunningTask({ id: 'task-a' })];
      }),
      resumeTaskAfterFixApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
  }

  function makePersistence() {
    return {
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 0 })),
      updateWorkflow: vi.fn(),
    };
  }

  function buildDeps(
    orchestrator: ReturnType<typeof makeBaseOrchestrator>,
    persistence: ReturnType<typeof makePersistence>,
    taskExecutor?: Partial<TaskRunner>,
  ) {
    return buildWorkflowInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      requireWorkflow: (workflowId) => {
        const workflow = persistence.loadWorkflow(workflowId);
        if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
        return workflow as any;
      },
      
      killActiveExecution: taskExecutor?.killActiveExecution?.bind(taskExecutor),
      prepareFreshBase: taskExecutor?.preparePoolForRebaseRetry
        ? async (workflowId, workflow) => {
          if (!workflow.repoUrl) return undefined;
          return taskExecutor.preparePoolForRebaseRetry!(
            workflowId,
            workflow.repoUrl,
            workflow.baseBranch,
          ) as any;
        }
        : undefined,
      fixApprove: async (taskId) => {
        const result = await approveTask(taskId, {
          orchestrator: orchestrator as unknown as Orchestrator,
          taskExecutor: taskExecutor as TaskRunner | undefined,
        });
        return result.started;
      },
      fixReject: (taskId) => {
        rejectTask(taskId, { orchestrator: orchestrator as unknown as Orchestrator });
        return [];
      },
    });
  }

  it('routes retry and recreate primitives through the orchestrator', async () => {
    const orchestrator = makeBaseOrchestrator();
    const persistence = makePersistence();
    const deps = buildDeps(orchestrator, persistence);

    await deps.retryTask('task-a');
    await deps.recreateTask('task-a');
    await deps.retryWorkflow('wf-1');
    await deps.recreateDownstream!('task-a');

    expect(orchestrator.retryTask).toHaveBeenCalledWith('task-a');
    expect(orchestrator.recreateTask).toHaveBeenCalledWith('task-a');
    expect(orchestrator.retryWorkflow).toHaveBeenCalledWith('wf-1');
    expect(orchestrator.recreateDownstream).toHaveBeenCalledWith('task-a');
  });

  it('bumps generation before recreateWorkflow', async () => {
    const orchestrator = makeBaseOrchestrator();
    const persistence = makePersistence();
    const deps = buildDeps(orchestrator, persistence);

    await deps.recreateWorkflow('wf-1');

    expect(persistence.loadWorkflow).not.toHaveBeenCalled();
    expect(persistence.updateWorkflow).not.toHaveBeenCalled();
    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
  });

  it('prepares fresh base and bumps generation before recreateWorkflowFromFreshBase', async () => {
    const orchestrator = makeBaseOrchestrator();
    const persistence = makePersistence();
    persistence.loadWorkflow = vi.fn(() => ({
      id: 'wf-1',
      generation: 4,
      repoUrl: 'https://example/repo.git',
      baseBranch: 'main',
    } as any));
    const taskExecutor = {
      preparePoolForRebaseRetry: vi.fn(async () => undefined),
    };
    const deps = buildDeps(orchestrator, persistence, taskExecutor);

    const result = await deps.recreateWorkflowFromFreshBase!('wf-1');

    expect(persistence.updateWorkflow).not.toHaveBeenCalled();
    expect(taskExecutor.preparePoolForRebaseRetry).toHaveBeenCalledWith(
      'wf-1',
      'https://example/repo.git',
      'main',
    );
    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith(
      'wf-1',
      expect.objectContaining({ refreshBase: expect.any(Function) }),
    );
    expect(result).toHaveLength(1);
  });

  it('routes workflowFork and scheduleOnly through orchestrator defaults', async () => {
    const orchestrator = makeBaseOrchestrator();
    const persistence = makePersistence();
    const deps = buildDeps(orchestrator, persistence);

    const forked = await deps.workflowFork!('wf-1');
    const scheduled = await deps.scheduleOnly!('task-a');

    expect(orchestrator.forkWorkflow).toHaveBeenCalledWith('wf-1');
    expect(forked[0]?.config.workflowId).toBe('wf-1-fork');
    expect(orchestrator.autoStartExternallyUnblockedReadyTasks).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
  });

  it('routes fixApprove and fixReject through the action wrappers', async () => {
    const started = [makeRunningTask({ id: 'task-a' })];
    const orchestrator = makeBaseOrchestrator();
    orchestrator.getTask = vi.fn()
      .mockReturnValueOnce(makeTask({ id: 'task-a', status: 'awaiting_approval', execution: {} }))
      .mockReturnValueOnce(makeTask({ id: 'task-a', execution: { pendingFixError: 'merge conflict' } }));
    orchestrator.approve = vi.fn().mockResolvedValue(started);
    const persistence = makePersistence();
    const deps = buildDeps(orchestrator, persistence);

    expect(await deps.fixApprove!('task-a')).toEqual(started);
    expect(await deps.fixReject!('task-a')).toEqual([]);
    expect(orchestrator.approve).toHaveBeenCalledWith('task-a');
    expect(orchestrator.revertFixSession).toHaveBeenCalledWith('task-a', { savedError: 'merge conflict' });
    expect(orchestrator.cancelTask).not.toHaveBeenCalled();
    expect(orchestrator.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('kills active executions via cancelInFlight hook', async () => {
    const orchestrator = makeBaseOrchestrator();
    orchestrator.cancelTask = vi.fn(() => ({
      cancelled: ['task-a'],
      runningCancelled: ['task-a'],
    }));
    const persistence = makePersistence();
    const taskExecutor = {
      killActiveExecution: vi.fn().mockResolvedValue(undefined),
    };
    const deps = buildDeps(orchestrator, persistence, taskExecutor);

    await deps.cancelInFlight('task', 'task-a');

    expect(orchestrator.cancelTask).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.killActiveExecution).toHaveBeenCalledWith('task-a');
  });

  it('delegates cascadeDownstream through workflow and task scope', async () => {
    const orchestrator = makeBaseOrchestrator();
    const persistence = makePersistence();
    const deps = buildDeps(orchestrator, persistence);

    expect(await deps.cascadeDownstream!('workflow', 'wf-1')).toHaveLength(1);
    await deps.cascadeDownstream!('task', 'task-a');

    expect(orchestrator.cascadeInvalidationToDownstream).toHaveBeenCalledWith('wf-1');
    expect(orchestrator.getTask).toHaveBeenCalledWith('task-a');
  });
});

describe('deleteAllWorkflows', () => {
  it('kills running and fixing_with_ai tasks before purging', async () => {
    const orchestrator = {
      getAllTasks: vi.fn(() => [
        makeTask({ id: 'r1', status: 'running' }),
        makeTask({ id: 'f1', status: 'fixing_with_ai' }),
        makeTask({ id: 'p1', status: 'pending' }),
        makeTask({ id: 'c1', status: 'completed' }),
      ]),
      deleteAllWorkflows: vi.fn(),
    };
    const taskExecutor = {
      killActiveExecution: vi.fn().mockResolvedValue(undefined),
    };

    await deleteAllWorkflows({
      orchestrator: orchestrator as unknown as Orchestrator,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    // Only running and fixing_with_ai tasks should be killed
    expect(taskExecutor.killActiveExecution).toHaveBeenCalledTimes(2);
    expect(taskExecutor.killActiveExecution).toHaveBeenCalledWith('r1');
    expect(taskExecutor.killActiveExecution).toHaveBeenCalledWith('f1');
    // Kills happen before deleteAllWorkflows
    expect(taskExecutor.killActiveExecution.mock.invocationCallOrder[0]).toBeLessThan(
      orchestrator.deleteAllWorkflows.mock.invocationCallOrder[0],
    );
  });

  it('proceeds without killing when taskExecutor is not provided', async () => {
    const orchestrator = {
      getAllTasks: vi.fn(() => [makeTask({ id: 'r1', status: 'running' })]),
      deleteAllWorkflows: vi.fn(),
    };

    await deleteAllWorkflows({
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(orchestrator.deleteAllWorkflows).toHaveBeenCalledTimes(1);
    // getAllTasks should not be called when there's no taskExecutor
    expect(orchestrator.getAllTasks).not.toHaveBeenCalled();
  });

  it('returns snapshot path from createDeleteAllSnapshot', async () => {
    const orchestrator = {
      getAllTasks: vi.fn(() => []),
      deleteAllWorkflows: vi.fn(),
    };

    const result = await deleteAllWorkflows({
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(result.snapshotPath).toBe('/tmp/fake-snapshot');
  });
});

// ── Lineage guard unit tests ──────────────────────────────────

describe('captureTaskLineage', () => {
  it('captures selectedAttemptId and generation from task', () => {
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        execution: { selectedAttemptId: 'att-1', generation: 3 },
      })),
    };
    const snapshot = captureTaskLineage('task-a', orchestrator as unknown as Orchestrator);
    expect(snapshot).toEqual({
      taskId: 'task-a',
      selectedAttemptId: 'att-1',
      generation: 3,
    });
  });

  it('defaults generation to 0 when task has no generation', () => {
    const orchestrator = {
      getTask: vi.fn(() => makeTask({ execution: {} })),
    };
    const snapshot = captureTaskLineage('task-a', orchestrator as unknown as Orchestrator);
    expect(snapshot.generation).toBe(0);
    expect(snapshot.selectedAttemptId).toBeUndefined();
  });
});

describe('assertLineageCurrent', () => {
  it('does nothing when lineage matches and signal is not aborted', () => {
    const snapshot = { taskId: 'task-a', selectedAttemptId: 'att-1', generation: 3 };
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        execution: { selectedAttemptId: 'att-1', generation: 3 },
      })),
    };
    expect(() => {
      assertLineageCurrent(snapshot, orchestrator as unknown as Orchestrator);
    }).not.toThrow();
  });

  it('throws StaleLineageError when selectedAttemptId changes', () => {
    const snapshot = { taskId: 'task-a', selectedAttemptId: 'att-1', generation: 3 };
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        execution: { selectedAttemptId: 'att-2', generation: 3 },
      })),
    };
    expect(() => {
      assertLineageCurrent(snapshot, orchestrator as unknown as Orchestrator);
    }).toThrow(StaleLineageError);
  });

  it('throws StaleLineageError when generation changes', () => {
    const snapshot = { taskId: 'task-a', selectedAttemptId: 'att-1', generation: 3 };
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        execution: { selectedAttemptId: 'att-1', generation: 4 },
      })),
    };
    expect(() => {
      assertLineageCurrent(snapshot, orchestrator as unknown as Orchestrator);
    }).toThrow(StaleLineageError);
  });

  it('throws StaleLineageError when signal is aborted', () => {
    const snapshot = { taskId: 'task-a', selectedAttemptId: 'att-1', generation: 3 };
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        execution: { selectedAttemptId: 'att-1', generation: 3 },
      })),
    };
    const ac = new AbortController();
    ac.abort(new Error('superseded'));
    expect(() => {
      assertLineageCurrent(snapshot, orchestrator as unknown as Orchestrator, ac.signal);
    }).toThrow(StaleLineageError);
  });
});

describe('fixWithAgentAction lineage guard', () => {
  it('throws StaleLineageError when lineage changes during async fix', async () => {
    let fixCallCount = 0;
    const orchestrator = {
      getTask: vi.fn(() => {
        fixCallCount++;
        if (fixCallCount <= 4) {
          return makeTask({
            status: 'failed',
            config: { workflowId: 'wf-1' },
            execution: { error: 'boom', workspacePath: '/tmp/task-a', selectedAttemptId: 'att-1', generation: 5 },
          });
        }
        // After fix returns, lineage has advanced
        return makeTask({
          status: 'pending',
          config: { workflowId: 'wf-1' },
          execution: { selectedAttemptId: 'att-2', generation: 6 },
        });
      }),
      beginFixSession: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn(),
    };

    await expect(fixWithAgentAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    })).rejects.toThrow(StaleLineageError);

    // Should NOT have called setFixAwaitingApproval (the late write)
    expect(orchestrator.setFixAwaitingApproval).not.toHaveBeenCalled();
    // Should NOT have called revertFixSession either
    expect(orchestrator.revertFixSession).not.toHaveBeenCalled();
  });

  it('throws StaleLineageError when signal is aborted during async fix', async () => {
    const ac = new AbortController();
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: { error: 'boom', workspacePath: '/tmp/task-a', selectedAttemptId: 'att-1', generation: 5 },
      })),
      beginFixSession: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn(async () => {
        // Abort happens during the fix
        ac.abort(new Error('Superseded by recreate'));
      }),
      resolveConflict: vi.fn(),
    };

    await expect(fixWithAgentAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    }, {
      signal: ac.signal,
    })).rejects.toThrow(StaleLineageError);

    expect(orchestrator.setFixAwaitingApproval).not.toHaveBeenCalled();
    expect(orchestrator.revertFixSession).not.toHaveBeenCalled();
  });

  it('skips revertFixSession when lineage changed and fix threw', async () => {
    let getTaskCallCount = 0;
    const orchestrator = {
      getTask: vi.fn(() => {
        getTaskCallCount++;
        if (getTaskCallCount <= 4) {
          return makeTask({
            status: 'failed',
            config: { workflowId: 'wf-1' },
            execution: { error: 'boom', workspacePath: '/tmp/task-a', selectedAttemptId: 'att-1', generation: 5 },
          });
        }
        // Lineage changed during fix
        return makeTask({
          status: 'pending',
          config: { workflowId: 'wf-1' },
          execution: { selectedAttemptId: 'att-2', generation: 6 },
        });
      }),
      beginFixSession: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockRejectedValue(new Error('agent crashed')),
      resolveConflict: vi.fn(),
    };

    await expect(fixWithAgentAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    })).rejects.toThrow(StaleLineageError);

    // revertFixSession must NOT be called when lineage is stale
    expect(orchestrator.revertFixSession).not.toHaveBeenCalled();
    expect(persistence.appendTaskOutput).not.toHaveBeenCalled();
  });

  it('proceeds normally when lineage is current', async () => {
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: { error: 'boom', workspacePath: '/tmp/task-a', selectedAttemptId: 'att-1', generation: 5 },
      })),
      beginFixSession: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn(),
    };

    const result = await fixWithAgentAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    });

    // Normal path should proceed
    expect(orchestrator.setFixAwaitingApproval).toHaveBeenCalledWith('task-a', 'boom');
    expect(result).toEqual({ kind: 'fixWithAgent', autoApproved: false, started: [] });
  });
});

describe('resolveConflictAction lineage guard', () => {
  it('throws StaleLineageError when lineage changes during conflict resolution', async () => {
    let getTaskCallCount = 0;
    const mergeError = JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'experiment/foo',
      conflictFiles: ['src/foo.ts'],
    });
    const orchestrator = {
      getTask: vi.fn(() => {
        getTaskCallCount++;
        if (getTaskCallCount <= 3) {
          return makeTask({
            status: 'fixing_with_ai',
            config: { workflowId: 'wf-1' },
            execution: { error: mergeError, workspacePath: '/tmp/task-a', selectedAttemptId: 'att-1', generation: 5 },
          });
        }
        // Lineage changed
        return makeTask({
          status: 'pending',
          config: { workflowId: 'wf-1' },
          execution: { selectedAttemptId: 'att-2', generation: 6 },
        });
      }),
      beginFixSession: vi.fn(() => ({ savedError: mergeError })),
      setFixAwaitingApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      resolveConflict: vi.fn().mockResolvedValue(undefined),
    };

    await expect(resolveConflictAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    })).rejects.toThrow(StaleLineageError);

    expect(orchestrator.setFixAwaitingApproval).not.toHaveBeenCalled();
    expect(orchestrator.revertFixSession).not.toHaveBeenCalled();
  });

  it('skips revertFixSession when lineage changed and resolution threw', async () => {
    let getTaskCallCount = 0;
    const orchestrator = {
      getTask: vi.fn(() => {
        getTaskCallCount++;
        if (getTaskCallCount <= 3) {
          return makeTask({
            status: 'fixing_with_ai',
            config: { workflowId: 'wf-1' },
            execution: { selectedAttemptId: 'att-1', generation: 5 },
          });
        }
        return makeTask({
          status: 'pending',
          config: { workflowId: 'wf-1' },
          execution: { selectedAttemptId: 'att-2', generation: 6 },
        });
      }),
      beginFixSession: vi.fn(() => ({ savedError: 'merge err' })),
      setFixAwaitingApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      appendTaskOutput: vi.fn(),
    };
    const taskExecutor = {
      resolveConflict: vi.fn().mockRejectedValue(new Error('resolution failed')),
    };

    await expect(resolveConflictAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    })).rejects.toThrow(StaleLineageError);

    expect(orchestrator.revertFixSession).not.toHaveBeenCalled();
    expect(persistence.appendTaskOutput).not.toHaveBeenCalledWith(
      'task-a',
      expect.stringContaining('[Auto-fix] Agent failed'),
    );
  });
});

describe('autoFixOnFailure lineage guard', () => {
  it('throws StaleLineageError when lineage changes after async fix', async () => {
    let getTaskCallCount = 0;
    const orchestrator = {
      getTask: vi.fn(() => {
        getTaskCallCount++;
        if (getTaskCallCount <= 4) {
          return makeTask({
            status: 'failed',
            config: { workflowId: 'wf-1' },
            execution: {
              error: 'boom',
              selectedAttemptId: 'att-1',
              generation: 5,
              workspacePath: '/tmp/task-a',
            },
          });
        }
        // Lineage advanced after fix returned
        return makeTask({
          status: 'pending',
          config: { workflowId: 'wf-1' },
          execution: { selectedAttemptId: 'att-2', generation: 6 },
        });
      }),
      beginFixSession: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      retryTask: vi.fn(() => []),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
      logEvent: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn(),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    await expect(autoFixOnFailure('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    })).rejects.toThrow(StaleLineageError);

    expect(orchestrator.setFixAwaitingApproval).not.toHaveBeenCalled();
    expect(orchestrator.retryTask).not.toHaveBeenCalled();
  });

  it('skips revertFixSession on failure when lineage changed', async () => {
    let getTaskCallCount = 0;
    const orchestrator = {
      getTask: vi.fn(() => {
        getTaskCallCount++;
        if (getTaskCallCount <= 4) {
          return makeTask({
            status: 'failed',
            config: { workflowId: 'wf-1' },
            execution: {
              error: 'boom',
              selectedAttemptId: 'att-1',
              generation: 5,
              workspacePath: '/tmp/task-a',
            },
          });
        }
        return makeTask({
          status: 'pending',
          config: { workflowId: 'wf-1' },
          execution: { selectedAttemptId: 'att-2', generation: 6 },
        });
      }),
      beginFixSession: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      retryTask: vi.fn(() => []),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
      logEvent: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockRejectedValue(new Error('agent crashed')),
      resolveConflict: vi.fn(),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    await expect(autoFixOnFailure('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
    })).rejects.toThrow(StaleLineageError);

    expect(orchestrator.revertFixSession).not.toHaveBeenCalled();
    expect(persistence.appendTaskOutput).not.toHaveBeenCalledWith(
      'task-a',
      expect.stringContaining('[Auto-fix] Agent failed'),
    );
  });

  it('throws StaleLineageError when signal is aborted during auto-fix', async () => {
    const ac = new AbortController();
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: {
          error: 'boom',
          selectedAttemptId: 'att-1',
          generation: 5,
          workspacePath: '/tmp/task-a',
        },
      })),
      beginFixSession: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      retryTask: vi.fn(() => []),
      revertFixSession: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      getTaskOutput: vi.fn(() => 'test output'),
      appendTaskOutput: vi.fn(),
      logEvent: vi.fn(),
    };
    const taskExecutor = {
      fixWithAgent: vi.fn(async () => {
        ac.abort(new Error('Superseded by recreate'));
      }),
      resolveConflict: vi.fn(),
      executeTasks: vi.fn().mockResolvedValue(undefined),
    };

    await expect(autoFixOnFailure('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      commandService: makeCommandService(),
      signal: ac.signal,
    })).rejects.toThrow(StaleLineageError);

    expect(orchestrator.setFixAwaitingApproval).not.toHaveBeenCalled();
    expect(orchestrator.retryTask).not.toHaveBeenCalled();
  });
});

describe('finalizeAppliedFix lineage guard', () => {
  it('throws StaleLineageError when signal is aborted before finalize', async () => {
    const ac = new AbortController();
    ac.abort(new Error('superseded'));
    const orchestrator = {
      setFixAwaitingApproval: vi.fn(),
    };

    await expect(finalizeAppliedFix('task-a', 'saved-error', {
      orchestrator: orchestrator as unknown as Orchestrator,
      taskExecutor: {} as TaskRunner,
    }, ac.signal)).rejects.toThrow(StaleLineageError);

    expect(orchestrator.setFixAwaitingApproval).not.toHaveBeenCalled();
  });

  it('proceeds normally when signal is not aborted', async () => {
    const ac = new AbortController();
    const orchestrator = {
      setFixAwaitingApproval: vi.fn(),
    };

    const result = await finalizeAppliedFix('task-a', 'saved-error', {
      orchestrator: orchestrator as unknown as Orchestrator,
      taskExecutor: {} as TaskRunner,
    }, ac.signal);

    expect(orchestrator.setFixAwaitingApproval).toHaveBeenCalledWith('task-a', 'saved-error');
    expect(result).toEqual({ autoApproved: false, started: [] });
  });
});

describe('fixWithAgentAction review-gate CI context', () => {
  function makeReviewGateOrchestrator(execution: Record<string, unknown>) {
    return {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: { error: 'ci failed', workspacePath: '/tmp/task-a', ...execution },
      })),
      beginFixSession: vi.fn(() => ({ savedError: 'ci failed' })),
      setFixAwaitingApproval: vi.fn(),
      revertFixSession: vi.fn(),
    };
  }

  it('rejects a stale review-gate context before mutating', async () => {
    const orchestrator = makeReviewGateOrchestrator({
      selectedAttemptId: 'attempt-2',
      generation: 3,
      reviewId: 'review-1',
      branch: 'experiment/foo',
    });
    const persistence = { getTaskOutput: vi.fn(() => 'output'), appendTaskOutput: vi.fn() };
    const taskExecutor = { fixWithAgent: vi.fn(), resolveConflict: vi.fn() };

    await expect(fixWithAgentAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    }, {
      reviewGateContext: { reviewId: 'review-1', generation: 3, selectedAttemptId: 'attempt-1', branch: 'experiment/foo' },
    })).rejects.toThrow(StaleLineageError);

    expect(taskExecutor.fixWithAgent).not.toHaveBeenCalled();
    expect(orchestrator.beginFixSession).not.toHaveBeenCalled();
  });

  it('fixes with the carried fix context when the review-gate context is current', async () => {
    const orchestrator = makeReviewGateOrchestrator({
      selectedAttemptId: 'attempt-1',
      generation: 3,
      reviewId: 'review-1',
      branch: 'experiment/foo',
    });
    const persistence = { getTaskOutput: vi.fn(() => 'output'), appendTaskOutput: vi.fn() };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockResolvedValue(undefined),
      resolveConflict: vi.fn(),
    };

    const result = await fixWithAgentAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    }, {
      agentName: 'claude',
      reviewGateContext: {
        reviewId: 'review-1',
        generation: 3,
        selectedAttemptId: 'attempt-1',
        branch: 'experiment/foo',
        fixContext: 'make the failed checks pass',
      },
    });

    expect(taskExecutor.fixWithAgent).toHaveBeenCalledWith(
      'task-a', 'output', 'claude', 'ci failed', 'make the failed checks pass',
    );
    // Review-gate CI fixes enter through beginFixSession, which accepts
    // review_ready/awaiting_approval entry states and records them.
    expect(orchestrator.beginFixSession).toHaveBeenCalledWith('task-a');
    expect(result).toEqual({ kind: 'fixWithAgent', autoApproved: false, started: [] });
  });

  it('reverts the fix session when a review-gate CI fix fails', async () => {
    const orchestrator = makeReviewGateOrchestrator({
      selectedAttemptId: 'attempt-1',
      generation: 3,
      reviewId: 'review-1',
      branch: 'experiment/foo',
    });
    const persistence = { getTaskOutput: vi.fn(() => 'output'), appendTaskOutput: vi.fn() };
    const taskExecutor = {
      fixWithAgent: vi.fn().mockRejectedValue(new Error('agent exploded')),
      resolveConflict: vi.fn(),
    };

    await expect(fixWithAgentAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    }, {
      agentName: 'claude',
      reviewGateContext: {
        reviewId: 'review-1',
        generation: 3,
        selectedAttemptId: 'attempt-1',
        branch: 'experiment/foo',
        fixContext: 'make the failed checks pass',
      },
    })).rejects.toThrow('agent exploded');

    expect(orchestrator.revertFixSession).toHaveBeenCalledWith('task-a', {
      savedError: 'ci failed',
      fixError: 'agent exploded',
    });
  });
});
