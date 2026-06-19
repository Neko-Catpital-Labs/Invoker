/**
 * Unit tests for shared workflow action functions.
 *
 * Each function is tested with mocked orchestrator/persistence deps,
 * following the pattern from resolve-conflict-action.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Orchestrator } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { TaskRunner } from '@invoker/execution-engine';
import {
  bumpGenerationAndRecreate,
  recreateWorkflow,
  recreateTask,
  cancelWorkflow,
  retryTask,
  retryWorkflow,
  recreateWorkflowFromFreshBase,
  rebaseRetry,
  rebaseRecreate,
  approveTask,
  rejectTask,
  provideInput,
  editTaskCommand,
  editTaskPrompt,
  editTaskType,
  selectExperiment,
  setWorkflowMergeMode,
  fixWithAgentAction,
  finalizeAppliedFix,
  autoFixOnFailure,
  buildCancelInFlight,
  buildInvalidationDeps,
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

describe('bumpGenerationAndRecreate', () => {
  let orchestrator: { recreateWorkflow: ReturnType<typeof vi.fn> };
  let persistence: {
    loadWorkflow: ReturnType<typeof vi.fn>;
    updateWorkflow: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    orchestrator = {
      recreateWorkflow: vi.fn(() => [makeRunningTask()]),
    };
    persistence = {
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 2 })),
      updateWorkflow: vi.fn(),
    };
  });

  it('loads workflow, bumps generation, calls orchestrator.recreateWorkflow', () => {
    const result = bumpGenerationAndRecreate('wf-1', {
      persistence: persistence as unknown as SQLiteAdapter,
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(persistence.loadWorkflow).toHaveBeenCalledWith('wf-1');
    expect(persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', { generation: 3 });
    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('running');
  });

  it('throws when workflow not found', () => {
    persistence.loadWorkflow.mockReturnValue(undefined);
    expect(() =>
      bumpGenerationAndRecreate('missing', {
        persistence: persistence as unknown as SQLiteAdapter,
        orchestrator: orchestrator as unknown as Orchestrator,
      }),
    ).toThrow('Workflow missing not found');
  });

  it('handles undefined generation (defaults to 0 + 1 = 1)', () => {
    persistence.loadWorkflow.mockReturnValue({ id: 'wf-1' });
    bumpGenerationAndRecreate('wf-1', {
      persistence: persistence as unknown as SQLiteAdapter,
      orchestrator: orchestrator as unknown as Orchestrator,
    });
    expect(persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', { generation: 1 });
  });
});

describe('recreateWorkflow', () => {
  it('delegates to bumpGenerationAndRecreate', () => {
    const orchestrator = { recreateWorkflow: vi.fn(() => [makeRunningTask()]) };
    const persistence = {
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 0 })),
      updateWorkflow: vi.fn(),
    };

    const result = recreateWorkflow('wf-1', {
      persistence: persistence as unknown as SQLiteAdapter,
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', { generation: 1 });
    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
    expect(result).toHaveLength(1);
  });
});

describe('recreateTask', () => {
  it('delegates to orchestrator.recreateTask', () => {
    const orchestrator = {
      recreateTask: vi.fn(() => [makeRunningTask()]),
    };
    const persistence = {
      loadWorkflow: vi.fn(),
      updateWorkflow: vi.fn(),
    };

    const result = recreateTask('task-a', {
      persistence: persistence as unknown as SQLiteAdapter,
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(orchestrator.recreateTask).toHaveBeenCalledWith('task-a');
    expect(persistence.updateWorkflow).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it('passes through orchestrator errors', () => {
    const orchestrator = {
      recreateTask: vi.fn(() => {
        throw new Error('Task missing-task not found');
      }),
    };
    const persistence = {
      loadWorkflow: vi.fn(),
      updateWorkflow: vi.fn(),
    };

    expect(() =>
      recreateTask('missing-task', {
        persistence: persistence as unknown as SQLiteAdapter,
        orchestrator: orchestrator as unknown as Orchestrator,
      }),
    ).toThrow('Task missing-task not found');
  });
});

describe('cancelWorkflow', () => {
  it('delegates to orchestrator.cancelWorkflow', () => {
    const orchestrator = {
      cancelWorkflow: vi.fn(() => ({ cancelled: ['task-a'], runningCancelled: ['task-a'] })),
    };

    const result = cancelWorkflow('wf-1', {
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(orchestrator.cancelWorkflow).toHaveBeenCalledWith('wf-1');
    expect(result).toEqual({ cancelled: ['task-a'], runningCancelled: ['task-a'] });
  });
});

describe('retryTask', () => {
  it('calls orchestrator.retryTask and returns result', () => {
    const tasks = [makeRunningTask()];
    const orchestrator = { retryTask: vi.fn(() => tasks) };

    const result = retryTask('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(orchestrator.retryTask).toHaveBeenCalledWith('task-a');
    expect(result).toBe(tasks);
  });
});

describe('retryWorkflow', () => {
  it('calls orchestrator.retryWorkflow and returns result', () => {
    const tasks = [makeRunningTask()];
    const orchestrator = { retryWorkflow: vi.fn(() => tasks) };

    const result = retryWorkflow('wf-1', {
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(orchestrator.retryWorkflow).toHaveBeenCalledWith('wf-1');
    expect(result).toBe(tasks);
  });
});

describe('recreateWorkflowFromFreshBase', () => {
  it('bumps generation and delegates to orchestrator.recreateWorkflowFromFreshBase with refreshBase callback', async () => {
    const tasks = [makeRunningTask()];
    const orchestrator = {
      recreateWorkflowFromFreshBase: vi.fn(async (_id: string, opts?: { refreshBase?: () => Promise<unknown> }) => {
        // Drive the refresh callback so we exercise pool prep wiring.
        await opts?.refreshBase?.();
        return tasks;
      }),
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
    } as unknown as TaskRunner;

    const result = await recreateWorkflowFromFreshBase('wf-1', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor,
    });

    expect(persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', { generation: 5 });
    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledTimes(1);
    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith(
      'wf-1',
      expect.objectContaining({ refreshBase: expect.any(Function) }),
    );
    // The whole reason this wrapper exists vs plain recreateWorkflow:
    // the refreshBase callback runs preparePoolForRebaseRetry.
    expect(taskExecutor.preparePoolForRebaseRetry).toHaveBeenCalledWith(
      'wf-1',
      'https://example/repo.git',
      'main',
    );
    expect(result).toBe(tasks);
  });

  it('throws when workflow not found', async () => {
    const orchestrator = { recreateWorkflowFromFreshBase: vi.fn(async () => []) };
    const persistence = { loadWorkflow: vi.fn(() => undefined), updateWorkflow: vi.fn() };

    await expect(
      recreateWorkflowFromFreshBase('missing', {
        orchestrator: orchestrator as unknown as Orchestrator,
        persistence: persistence as unknown as SQLiteAdapter,
      }),
    ).rejects.toThrow('Workflow missing not found');
  });
});

describe('rebaseRetry', () => {
  it('translates target → workflowId, prepares fresh base, and delegates to retryWorkflow', async () => {
    const tasks = [makeRunningTask()];
    const orchestrator = {
      getTask: vi.fn(() => makeTask({ config: { workflowId: 'wf-1' } })),
      retryWorkflow: vi.fn(() => tasks),
    };
    const persistence = {
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 1, repoUrl: 'https://example/repo.git', baseBranch: 'master' })),
      listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
      loadTasks: vi.fn(() => []),
      updateWorkflow: vi.fn(),
    };

    const result = await rebaseRetry('wf-1/task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });

    expect(orchestrator.retryWorkflow).toHaveBeenCalledWith('wf-1');
    expect(persistence.updateWorkflow).not.toHaveBeenCalled();
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
        orchestrator: orchestrator as unknown as Orchestrator,
        persistence: persistence as unknown as SQLiteAdapter,
      }),
    ).rejects.toThrow('Could not resolve workflow for rebase target "missing-task"');
  });
});

describe('rebaseRecreate', () => {
  it('prepares fresh base, then delegates to recreateWorkflow', async () => {
    const tasks = [makeRunningTask()];
    const orchestrator = {
      getTask: vi.fn(() => undefined),
      recreateWorkflow: vi.fn(() => tasks),
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
    } as unknown as TaskRunner;

    const result = await rebaseRecreate('wf-1', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor,
    });

    expect(persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', { generation: 3 });
    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
    expect(taskExecutor.preparePoolForRebaseRetry).toHaveBeenCalledWith(
      'wf-1',
      'https://example/repo.git',
      'main',
    );
    expect(result).toBe(tasks);
  });

  it('throws when workflow not found', async () => {
    const orchestrator = { getTask: vi.fn(() => undefined), recreateWorkflow: vi.fn(() => []) };
    const persistence = { loadWorkflow: vi.fn(() => undefined), listWorkflows: vi.fn(() => []), loadTasks: vi.fn(() => []), updateWorkflow: vi.fn() };

    await expect(
      rebaseRecreate('missing', {
        orchestrator: orchestrator as unknown as Orchestrator,
        persistence: persistence as unknown as SQLiteAdapter,
      }),
    ).rejects.toThrow('Could not resolve workflow for rebase target "missing"');
  });
});

// Step 17 (`docs/architecture/task-invalidation-roadmap.md` and the
// chart's "Proposed API Direction"): pin the canonical
// `{retry, recreate} × {task, workflow}` matrix at the
// app-layer wrapper surface. This is the lock-in that prevents
// future refactors from accidentally dropping any of the five
// canonical lifecycle wrappers (or routing a new one through a
// legacy compat layer like `restartTask`).
describe('Step 17: app-layer wrappers expose the 5-cell lifecycle matrix', () => {
  it('exports retryTask, recreateTask, retryWorkflow, recreateWorkflow, recreateWorkflowFromFreshBase', () => {
    expect(typeof retryTask).toBe('function');
    expect(typeof recreateTask).toBe('function');
    expect(typeof retryWorkflow).toBe('function');
    expect(typeof recreateWorkflow).toBe('function');
    expect(typeof recreateWorkflowFromFreshBase).toBe('function');
  });

  it('each wrapper routes to the matching orchestrator primitive (no restartTask path)', async () => {
    const orchestrator = {
      retryTask: vi.fn(() => []),
      recreateTask: vi.fn(() => []),
      retryWorkflow: vi.fn(() => []),
      recreateWorkflow: vi.fn(() => []),
      recreateWorkflowFromFreshBase: vi.fn(async () => []),
      restartTask: vi.fn(() => []),
    };
    const persistence = {
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 0 })),
      updateWorkflow: vi.fn(),
    };

    retryTask('task-a', { orchestrator: orchestrator as unknown as Orchestrator });
    recreateTask('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });
    retryWorkflow('wf-1', { orchestrator: orchestrator as unknown as Orchestrator });
    recreateWorkflow('wf-1', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });
    await recreateWorkflowFromFreshBase('wf-1', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });

    expect(orchestrator.retryTask).toHaveBeenCalledWith('task-a');
    expect(orchestrator.recreateTask).toHaveBeenCalledWith('task-a');
    expect(orchestrator.retryWorkflow).toHaveBeenCalledWith('wf-1');
    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith(
      'wf-1',
      expect.objectContaining({ refreshBase: expect.any(Function) }),
    );
    // No production wrapper in the canonical matrix may route
    // through the deprecated `restartTask` shim.
    expect(orchestrator.restartTask).not.toHaveBeenCalled();
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
    revertConflictResolution: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    orchestrator = {
      getTask: vi.fn(() => makeTask({ execution: {} })),
      reject: vi.fn(),
      revertConflictResolution: vi.fn(),
    };
  });

  it('calls orchestrator.reject when no pendingFixError', () => {
    rejectTask('task-a', { orchestrator: orchestrator as unknown as Orchestrator }, 'bad output');

    expect(orchestrator.reject).toHaveBeenCalledWith('task-a', 'bad output');
    expect(orchestrator.revertConflictResolution).not.toHaveBeenCalled();
  });

  it('calls orchestrator.revertConflictResolution when pendingFixError exists', () => {
    orchestrator.getTask.mockReturnValue(
      makeTask({ execution: { pendingFixError: 'merge conflict' } }),
    );

    rejectTask('task-a', { orchestrator: orchestrator as unknown as Orchestrator });

    expect(orchestrator.revertConflictResolution).toHaveBeenCalledWith('task-a', 'merge conflict');
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
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: { autoFixAttempts: 0, error: mergeError },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: mergeError })),
      recreateWorkflowFromFreshBase: vi.fn(async (_workflowId: string, options?: { refreshBase?: () => Promise<unknown> }) => {
        await options?.refreshBase?.();
        return started;
      }),
      retryTask: vi.fn(() => []),
      revertConflictResolution: vi.fn(),
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
    });

    expect(orchestrator.beginConflictResolution).not.toHaveBeenCalled();
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
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        execution: { autoFixAttempts: 0, error: 'boom', workspacePath: '/tmp/task-a' },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      retryTask: vi.fn(() => started),
      revertConflictResolution: vi.fn(),
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
    });

    expect(orchestrator.beginConflictResolution).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.fixWithAgent).toHaveBeenCalledWith('task-a', 'test output', 'claude', 'boom');
    expect(taskExecutor.resolveConflict).not.toHaveBeenCalled();
    expect(orchestrator.retryTask).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.executeTasks).toHaveBeenCalledWith(started);
  });

  it('skips auto-fix when workspacePath is missing for non-recreate routes', async () => {
    const orchestrator = {
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        execution: { autoFixAttempts: 0, error: 'boom' },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      retryTask: vi.fn(() => []),
      revertConflictResolution: vi.fn(),
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
    });

    expect(orchestrator.beginConflictResolution).not.toHaveBeenCalled();
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
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        execution: { autoFixAttempts: 0, error: mergeError, workspacePath: '/tmp/task-a' },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: mergeError })),
      retryTask: vi.fn(() => started),
      revertConflictResolution: vi.fn(),
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
    });

    expect(orchestrator.beginConflictResolution).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith('task-a', mergeError, 'claude');
    expect(taskExecutor.fixWithAgent).not.toHaveBeenCalled();
    expect(orchestrator.retryTask).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.executeTasks).toHaveBeenCalledWith(started);
  });

  it('uses resolveConflict for prefixed post-fix merge conflict errors', async () => {
    const started = [makeRunningTask({ id: 'task-a', status: 'running' })];
    const mergeError = `Post-fix PR prep failed: ${JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'experiment/foo',
      conflictFiles: ['src/foo.ts'],
    })}`;
    const orchestrator = {
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        execution: { autoFixAttempts: 0, error: mergeError, workspacePath: '/tmp/task-a' },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: mergeError })),
      retryTask: vi.fn(() => started),
      revertConflictResolution: vi.fn(),
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
    });

    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith('task-a', mergeError, 'claude');
    expect(taskExecutor.fixWithAgent).not.toHaveBeenCalled();
  });

  it('records fixed integration anchor and routes merge gates to finalize/publish flow', async () => {
    const started = [
      makeRunningTask({ id: 'merge-a', config: { workflowId: 'wf-1', isMergeNode: true } }),
    ];
    const orchestrator = {
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => makeTask({
        id: 'merge-a',
        status: 'failed',
        config: { workflowId: 'wf-1', isMergeNode: true },
        execution: { autoFixAttempts: 0, workspacePath: '/tmp/merge-a' },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      retryTask: vi.fn(() => []),
      setFixAwaitingApproval: vi.fn(),
      approve: vi.fn().mockResolvedValue(started),
      revertConflictResolution: vi.fn(),
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
    // advances at known transition points (beginConflictResolution
    // and setFixAwaitingApproval) to keep return values consistent.
    let phase = 0;
    const phases: Record<string, unknown>[] = [
      // Phase 0: entry check + lineage capture (cycle 1)
      { status: 'failed', execution: { autoFixAttempts: 0, workspacePath: '/tmp/merge-a', selectedAttemptId: 'att-1', generation: 1 } },
      // Phase 1: after fix returns, lineage check + finalize + approveTask (cycle 1)
      { status: 'awaiting_approval', execution: { autoFixAttempts: 1, workspacePath: '/tmp/merge-a', pendingFixError: 'boom', selectedAttemptId: 'att-1', generation: 1 } },
      // Phase 2: post-finalize check — task re-failed after publish
      { status: 'failed', execution: { autoFixAttempts: 1, workspacePath: '/tmp/merge-a', error: 'Post-fix PR prep failed: conflict', selectedAttemptId: 'att-1', generation: 1 } },
      // Phase 3: inline retry entry + lineage capture (cycle 2)
      { status: 'failed', execution: { autoFixAttempts: 1, workspacePath: '/tmp/merge-a', selectedAttemptId: 'att-3', generation: 3 } },
      // Phase 4: after fix returns, lineage check + finalize + approveTask (cycle 2)
      { status: 'awaiting_approval', execution: { autoFixAttempts: 2, workspacePath: '/tmp/merge-a', pendingFixError: 'boom', selectedAttemptId: 'att-3', generation: 3 } },
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
    const origBeginConflictResolution = vi.fn(() => {
      phase++;
      return { savedError: 'boom' };
    });
    const origSetFixAwaitingApproval = vi.fn(() => { phase++; });
    const shouldAutoFix = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const orchestrator = {
      shouldAutoFix,
      getTask,
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: origBeginConflictResolution,
      retryTask: vi.fn(() => []),
      setFixAwaitingApproval: origSetFixAwaitingApproval,
      approve: vi.fn().mockResolvedValue(started),
      resumeTaskAfterFixApproval: vi.fn().mockResolvedValue(started),
      revertConflictResolution: vi.fn(),
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
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1', executionAgent: 'claude' },
        execution: { autoFixAttempts: 0, workspacePath: '/tmp/task-a' },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      retryTask: vi.fn(() => started),
      revertConflictResolution: vi.fn(),
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
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1', executionAgent: 'codex' },
        execution: { autoFixAttempts: 0, workspacePath: '/tmp/task-a' },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      retryTask: vi.fn(() => started),
      revertConflictResolution: vi.fn(),
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
      getAutoFixAgent: () => '   ',
    });

    expect(taskExecutor.fixWithAgent).toHaveBeenCalledWith('task-a', 'test output', 'claude', 'boom');
    expect(logEvent).toHaveBeenCalledWith(
      'task-a',
      'debug.auto-fix',
      expect.objectContaining({
        phase: 'auto-fix-agent-selected',
        selectedAgent: 'claude',
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
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: { autoFixAttempts: 0, error: mergeError, workspacePath: '/tmp/task-a' },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: mergeError })),
      retryTask: vi.fn(() => started),
      revertConflictResolution: vi.fn(),
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
      getAutoFixAgent: () => undefined,
    });

    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith('task-a', mergeError, 'claude');
    expect(logEvent).toHaveBeenCalledWith(
      'task-a',
      'debug.auto-fix',
      expect.objectContaining({
        phase: 'auto-fix-agent-selected',
        selectedAgent: 'claude',
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
        execution: { error: 'boom' },
      })),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      revertConflictResolution: vi.fn(),
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
    }, {
      agentName: 'codex',
    });

    expect(taskExecutor.fixWithAgent).toHaveBeenCalledWith('task-a', 'test output', 'codex', 'boom');
    expect(taskExecutor.resolveConflict).not.toHaveBeenCalled();
    expect(orchestrator.setFixAwaitingApproval).toHaveBeenCalledWith('task-a', 'boom');
    expect(result).toEqual({ kind: 'fixWithAgent', autoApproved: false, started: [] });
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
      beginConflictResolution: vi.fn(() => ({ savedError: mergeError })),
      setFixAwaitingApproval: vi.fn(),
      revertConflictResolution: vi.fn(),
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
    }, {
      agentName: 'claude',
    });

    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith('task-a', mergeError, 'claude');
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
      beginConflictResolution: vi.fn(() => ({ savedError: mergeError })),
      setFixAwaitingApproval: vi.fn(),
      revertConflictResolution: vi.fn(),
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
    }, {
      agentName: 'codex',
    });

    expect(taskExecutor.resolveConflict).toHaveBeenCalledWith('task-a', mergeError, 'codex');
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
      recreateWorkflowFromFreshBase: vi.fn(() => [makeRunningTask({ id: 'task-a', status: 'running' })]),
    };
    const persistence = {
      appendTaskOutput: vi.fn(),
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 2 })),
      updateWorkflow: vi.fn(),
    };
    const taskExecutor = {
      preparePoolForRebaseRetry: vi.fn().mockResolvedValue(undefined),
    };

    const result = await fixWithAgentAction('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    }, {
      recreateOutputLabel: 'Fix with AI',
    });

    expect(persistence.appendTaskOutput).toHaveBeenCalledWith(
      'task-a',
      expect.stringContaining('Startup merge conflict detected; recreating workflow wf-1 from a fresh base.'),
    );
    expect(persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', { generation: 3 });
    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith('wf-1', expect.any(Object));
    expect(result).toEqual({
      kind: 'recreateWorkflowFromFreshBase',
      workflowId: 'wf-1',
      started: [expect.objectContaining({ id: 'task-a', status: 'running' })],
    });
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

describe('editTaskType', () => {
  it('calls orchestrator.editTaskType and returns result', () => {
    const tasks = [makeRunningTask()];
    const orchestrator = { editTaskType: vi.fn(() => tasks) };

    const result = editTaskType('task-a', 'docker', {
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(orchestrator.editTaskType).toHaveBeenCalledWith('task-a', 'docker', undefined);
    expect(result).toBe(tasks);
  });

  it('passes poolMemberId when provided', () => {
    const orchestrator = { editTaskType: vi.fn(() => []) };

    editTaskType('task-a', 'ssh', { orchestrator: orchestrator as unknown as Orchestrator }, 'remote-1');

    expect(orchestrator.editTaskType).toHaveBeenCalledWith('task-a', 'ssh', 'remote-1');
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
      taskExecutor: taskExecutor as unknown as TaskRunner,
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
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });
    await cancel('workflow', 'wf-1');

    expect(orchestrator.cancelWorkflow).toHaveBeenCalledWith('wf-1');
    expect(taskExecutor.killActiveExecution).toHaveBeenCalledTimes(2);
    expect(taskExecutor.killActiveExecution).toHaveBeenNthCalledWith(1, 'task-a');
    expect(taskExecutor.killActiveExecution).toHaveBeenNthCalledWith(2, 'task-b');
    expect(orchestrator.cancelWorkflow.mock.invocationCallOrder[0]).toBeLessThan(
      taskExecutor.killActiveExecution.mock.invocationCallOrder[0],
    );
    expect(orchestrator.cancelTask).not.toHaveBeenCalled();
  });

  it('is a no-op when scope is "none"', async () => {
    const orchestrator = { cancelTask: vi.fn(), cancelWorkflow: vi.fn() };
    const taskExecutor = { killActiveExecution: vi.fn() };

    const cancel = buildCancelInFlight({
      orchestrator: orchestrator as unknown as Orchestrator,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });
    await cancel('none', 'whatever');

    expect(orchestrator.cancelTask).not.toHaveBeenCalled();
    expect(orchestrator.cancelWorkflow).not.toHaveBeenCalled();
    expect(taskExecutor.killActiveExecution).not.toHaveBeenCalled();
  });

  it('still cancels orchestrator state when no taskExecutor is provided', async () => {
    const orchestrator = {
      cancelTask: vi.fn(() => ({ cancelled: ['task-a'], runningCancelled: ['task-a'] })),
      cancelWorkflow: vi.fn(),
    };
    const cancel = buildCancelInFlight({
      orchestrator: orchestrator as unknown as Orchestrator,
    });
    await cancel('task', 'task-a');

    expect(orchestrator.cancelTask).toHaveBeenCalledWith('task-a');
  });
});

describe('buildInvalidationDeps', () => {
  function makeBaseOrchestrator() {
    return {
      retryTask: vi.fn(() => [makeRunningTask({ id: 'task-a' })]),
      recreateTask: vi.fn(() => [makeRunningTask({ id: 'task-a' })]),
      retryWorkflow: vi.fn(() => [makeRunningTask({ id: 'task-a' })]),
      recreateWorkflow: vi.fn(() => [makeRunningTask({ id: 'task-a' })]),
      cancelTask: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
      cancelWorkflow: vi.fn(() => ({ cancelled: [], runningCancelled: [] })),
    };
  }
  function makePersistence() {
    return {
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', generation: 0 })),
      updateWorkflow: vi.fn(),
    };
  }

  it('routes retryTask to orchestrator.retryTask', async () => {
    const orchestrator = makeBaseOrchestrator();
    const persistence = makePersistence();

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });
    const result = await deps.retryTask('task-a');

    expect(orchestrator.retryTask).toHaveBeenCalledWith('task-a');
    expect(orchestrator.recreateTask).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it('routes recreateTask to orchestrator.recreateTask', async () => {
    const orchestrator = makeBaseOrchestrator();
    const persistence = makePersistence();

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });
    await deps.recreateTask('task-a');

    expect(orchestrator.recreateTask).toHaveBeenCalledWith('task-a');
  });

  it('routes retryWorkflow to orchestrator.retryWorkflow', async () => {
    const orchestrator = makeBaseOrchestrator();
    const persistence = makePersistence();

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });
    await deps.retryWorkflow('wf-1');

    expect(orchestrator.retryWorkflow).toHaveBeenCalledWith('wf-1');
  });

  it('routes recreateWorkflow through bumpGenerationAndRecreate', async () => {
    const orchestrator = makeBaseOrchestrator();
    const persistence = makePersistence();

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });
    await deps.recreateWorkflow('wf-1');

    expect(persistence.loadWorkflow).toHaveBeenCalledWith('wf-1');
    expect(persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', { generation: 1 });
    expect(orchestrator.recreateWorkflow).toHaveBeenCalledWith('wf-1');
  });

  it('wires recreateWorkflowFromFreshBase to the orchestrator method', async () => {
    const orchestrator = {
      ...makeBaseOrchestrator(),
      // The real orchestrator drives the `refreshBase` callback; mirror
      // that here so the test exercises the app-layer's pool-prep wiring.
      recreateWorkflowFromFreshBase: vi.fn(async (_id: string, options?: any) => {
        await options?.refreshBase?.(_id);
        return [makeRunningTask({ id: 'task-a' })];
      }),
    };
    const persistence = makePersistence();
    const taskExecutor = {
      preparePoolForRebaseRetry: vi.fn(async () => undefined),
    };

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    // Step 12 promotes this dep — the policy router's
    // "not yet wired (Step 12)" error path is dead code in production.
    expect(deps.recreateWorkflowFromFreshBase).toBeDefined();

    persistence.loadWorkflow = vi.fn(() => ({
      id: 'wf-1',
      generation: 4,
      repoUrl: 'https://example/repo.git',
      baseBranch: 'main',
    } as any));

    const result = await deps.recreateWorkflowFromFreshBase!('wf-1');

    // Workflow generation bumped (matches recreateWorkflow's wrapper semantics).
    expect(persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', { generation: 5 });
    // Pool prep ran before delegating to the orchestrator's first-class method.
    expect(taskExecutor.preparePoolForRebaseRetry).toHaveBeenCalledWith(
      'wf-1',
      'https://example/repo.git',
      'main',
    );
    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledTimes(1);
    expect(orchestrator.recreateWorkflowFromFreshBase.mock.calls[0]?.[0]).toBe('wf-1');
    expect(result).toHaveLength(1);
  });

  it('recreateWorkflowFromFreshBase wire still calls orchestrator method when no taskExecutor is supplied', async () => {
    const orchestrator = {
      ...makeBaseOrchestrator(),
      recreateWorkflowFromFreshBase: vi.fn(async () => []),
    };
    const persistence = makePersistence();
    persistence.loadWorkflow = vi.fn(() => ({ id: 'wf-1', generation: 0, repoUrl: 'https://example/repo.git', baseBranch: 'main' } as any));

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      // taskExecutor intentionally omitted — the orchestrator method
      // still runs (refreshBase callback is a no-op without an executor).
    });

    await deps.recreateWorkflowFromFreshBase!('wf-1');

    expect(orchestrator.recreateWorkflowFromFreshBase).toHaveBeenCalledWith(
      'wf-1',
      expect.objectContaining({ refreshBase: expect.any(Function) }),
    );
  });

  // Step 14 (`docs/architecture/task-invalidation-roadmap.md`,
  // chart "Topology inconsistency"): `workflowFork` is wired to
  // `Orchestrator.forkWorkflow`. The policy router only consumes
  // the `started` task list, so the wire adapts the orchestrator's
  // richer `ForkWorkflowResult` to `TaskState[]`. The forked
  // workflow id remains discoverable via `started[0].config.workflowId`
  // for callers that need it.
  it('routes workflowFork to orchestrator.forkWorkflow and returns started tasks', async () => {
    const orchestrator = {
      ...makeBaseOrchestrator(),
      forkWorkflow: vi.fn((workflowId: string) => ({
        sourceWorkflowId: workflowId,
        forkedWorkflowId: `${workflowId}-fork`,
        started: [makeRunningTask({ id: `${workflowId}-fork/task-a`, config: { workflowId: `${workflowId}-fork` } as any })],
      })),
    };
    const persistence = makePersistence();

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });

    expect(deps.workflowFork).toBeDefined();
    const result = await deps.workflowFork!('wf-1');

    expect(orchestrator.forkWorkflow).toHaveBeenCalledWith('wf-1');
    expect(result).toHaveLength(1);
    // The forked workflow id is discoverable from the returned tasks.
    expect((result as any[])[0].config.workflowId).toBe('wf-1-fork');
  });

  // Step 16 (`docs/architecture/task-invalidation-roadmap.md`,
  // chart row "Approve or reject fix"): `fixApprove` and
  // `fixReject` are wired to the existing `approveTask` /
  // `rejectTask` action wrappers in this file. Per the chart
  // these are non-invalidating control flow over an existing
  // fix attempt's output, so the wires must:
  //
  //   - reach the orchestrator's approve/reject primitives
  //     (NOT retry/recreate);
  //   - never call `orchestrator.cancelTask` /
  //     `orchestrator.cancelWorkflow` (the policy router skips
  //     `cancelInFlight` for these actions);
  //   - return `TaskState[]` (approve returns the started
  //     follow-on tasks; reject returns `[]` because the
  //     wrapper is `void` today).
  //
  // The Step 1 scaffolding test pattern above wires the deps
  // through `buildInvalidationDeps` and invokes them directly
  // with a partial orchestrator mock; we follow that pattern.
  it('routes fixApprove through approveTask (non-fix path → orchestrator.approve, returns started, never retry/recreate/cancel)', async () => {
    const started = [makeRunningTask({ id: 'task-a' })];
    const approvedTask = makeTask({ id: 'task-a', status: 'awaiting_approval', execution: {} });
    const orchestrator = {
      ...makeBaseOrchestrator(),
      getTask: vi.fn().mockReturnValue(approvedTask),
      approve: vi.fn().mockResolvedValue(started),
      resumeTaskAfterFixApproval: vi.fn(),
    };
    const persistence = makePersistence();

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });

    expect(deps.fixApprove).toBeDefined();
    const result = await deps.fixApprove!('task-a');

    expect(orchestrator.approve).toHaveBeenCalledWith('task-a');
    expect(orchestrator.resumeTaskAfterFixApproval).not.toHaveBeenCalled();
    expect(result).toEqual(started);
    expect(orchestrator.retryTask).not.toHaveBeenCalled();
    expect(orchestrator.recreateTask).not.toHaveBeenCalled();
    expect(orchestrator.retryWorkflow).not.toHaveBeenCalled();
    expect(orchestrator.recreateWorkflow).not.toHaveBeenCalled();
    expect(orchestrator.cancelTask).not.toHaveBeenCalled();
    expect(orchestrator.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('routes fixApprove through approveTask (fix path → commitApprovedFix + orchestrator.approve)', async () => {
    const started = [makeRunningTask({ id: 'task-a' })];
    const approvedTask = makeTask({
      id: 'task-a',
      status: 'awaiting_approval',
      config: { workflowId: 'wf-1' },
      execution: { pendingFixError: 'plain failure', branch: 'task-a', workspacePath: '/tmp/task-a' },
    });
    const orchestrator = {
      ...makeBaseOrchestrator(),
      getTask: vi.fn().mockReturnValue(approvedTask),
      approve: vi.fn().mockResolvedValue(started),
      resumeTaskAfterFixApproval: vi.fn(),
    };
    const persistence = makePersistence();
    const taskExecutor = {
      commitApprovedFix: vi.fn(),
      publishAfterFix: vi.fn(),
      executeTasks: vi.fn(),
    };

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    const result = await deps.fixApprove!('task-a');

    expect(taskExecutor.commitApprovedFix).toHaveBeenCalledWith(approvedTask);
    expect(orchestrator.approve).toHaveBeenCalledWith('task-a');
    expect(orchestrator.resumeTaskAfterFixApproval).not.toHaveBeenCalled();
    expect(result).toEqual(started);
    expect(orchestrator.cancelTask).not.toHaveBeenCalled();
    expect(orchestrator.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('routes fixReject through rejectTask (fix-flow path → orchestrator.revertConflictResolution, returns [], never retry/recreate/cancel)', async () => {
    const orchestrator = {
      ...makeBaseOrchestrator(),
      getTask: vi.fn().mockReturnValue(
        makeTask({ id: 'task-a', execution: { pendingFixError: 'merge conflict' } }),
      ),
      reject: vi.fn(),
      revertConflictResolution: vi.fn(),
    };
    const persistence = makePersistence();

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });

    expect(deps.fixReject).toBeDefined();
    const result = await deps.fixReject!('task-a');

    expect(orchestrator.revertConflictResolution).toHaveBeenCalledWith('task-a', 'merge conflict');
    expect(orchestrator.reject).not.toHaveBeenCalled();
    // `rejectTask` is `void` today; the wire returns `[]` so the
    // policy router's `TaskState[]` contract is satisfied.
    expect(result).toEqual([]);
    expect(orchestrator.retryTask).not.toHaveBeenCalled();
    expect(orchestrator.recreateTask).not.toHaveBeenCalled();
    expect(orchestrator.retryWorkflow).not.toHaveBeenCalled();
    expect(orchestrator.recreateWorkflow).not.toHaveBeenCalled();
    expect(orchestrator.cancelTask).not.toHaveBeenCalled();
    expect(orchestrator.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('routes fixReject through rejectTask (non-fix path → orchestrator.reject)', async () => {
    const orchestrator = {
      ...makeBaseOrchestrator(),
      getTask: vi.fn().mockReturnValue(
        makeTask({ id: 'task-a', execution: {} }),
      ),
      reject: vi.fn(),
      revertConflictResolution: vi.fn(),
    };
    const persistence = makePersistence();

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });

    const result = await deps.fixReject!('task-a');

    // `rejectTask` is invoked without a reason from the wire, so
    // `orchestrator.reject` is called as `(taskId, undefined)`.
    expect(orchestrator.reject).toHaveBeenCalledWith('task-a', undefined);
    expect(orchestrator.revertConflictResolution).not.toHaveBeenCalled();
    expect(result).toEqual([]);
    expect(orchestrator.cancelTask).not.toHaveBeenCalled();
    expect(orchestrator.cancelWorkflow).not.toHaveBeenCalled();
  });

  it('builds a cancel-first hook that cancels orchestrator state and kills runners', async () => {
    const orchestrator = makeBaseOrchestrator();
    orchestrator.cancelTask = vi.fn(() => ({
      cancelled: ['task-a'],
      runningCancelled: ['task-a'],
    }));
    const persistence = makePersistence();
    const taskExecutor = {
      killActiveExecution: vi.fn().mockResolvedValue(undefined),
    };

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });
    await deps.cancelInFlight('task', 'task-a');

    expect(orchestrator.cancelTask).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.killActiveExecution).toHaveBeenCalledWith('task-a');
    expect(orchestrator.cancelTask.mock.invocationCallOrder[0]).toBeLessThan(
      taskExecutor.killActiveExecution.mock.invocationCallOrder[0],
    );
  });

  // Cross-workflow cascade wiring: a task-scoped id resolves to its
  // owning workflowId via `orchestrator.getTask(id)?.config.workflowId`,
  // then delegates to `Orchestrator.cascadeInvalidationToDownstream`.
  it('exposes cascadeDownstream that delegates to orchestrator.cascadeInvalidationToDownstream for workflow scope', async () => {
    const cascaded = [makeRunningTask({ id: 'wf-2/leaf' })];
    const orchestrator = {
      ...makeBaseOrchestrator(),
      cascadeInvalidationToDownstream: vi.fn(() => cascaded),
      getTask: vi.fn(() => undefined),
    };
    const persistence = makePersistence();

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });

    expect(deps.cascadeDownstream).toBeDefined();
    const result = await deps.cascadeDownstream!('workflow', 'wf-1');

    expect(orchestrator.cascadeInvalidationToDownstream).toHaveBeenCalledWith('wf-1');
    expect(orchestrator.getTask).not.toHaveBeenCalled();
    expect(result).toEqual(cascaded);
  });

  it('cascadeDownstream resolves task scope to workflowId via orchestrator.getTask', async () => {
    const orchestrator = {
      ...makeBaseOrchestrator(),
      cascadeInvalidationToDownstream: vi.fn(() => []),
      getTask: vi.fn(() => ({
        id: 'task-a',
        config: { workflowId: 'wf-resolved' },
      })),
    };
    const persistence = makePersistence();

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });

    await deps.cascadeDownstream!('task', 'task-a');

    expect(orchestrator.getTask).toHaveBeenCalledWith('task-a');
    expect(orchestrator.cascadeInvalidationToDownstream).toHaveBeenCalledWith('wf-resolved');
  });

  it('cascadeDownstream returns [] without calling orchestrator when task is not found', async () => {
    const orchestrator = {
      ...makeBaseOrchestrator(),
      cascadeInvalidationToDownstream: vi.fn(() => []),
      getTask: vi.fn(() => undefined),
    };
    const persistence = makePersistence();

    const deps = buildInvalidationDeps({
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
    });

    const result = await deps.cascadeDownstream!('task', 'unknown-task');

    expect(orchestrator.getTask).toHaveBeenCalledWith('unknown-task');
    expect(orchestrator.cascadeInvalidationToDownstream).not.toHaveBeenCalled();
    expect(result).toEqual([]);
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
            execution: { error: 'boom', selectedAttemptId: 'att-1', generation: 5 },
          });
        }
        // After fix returns, lineage has advanced
        return makeTask({
          status: 'pending',
          config: { workflowId: 'wf-1' },
          execution: { selectedAttemptId: 'att-2', generation: 6 },
        });
      }),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      revertConflictResolution: vi.fn(),
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
    })).rejects.toThrow(StaleLineageError);

    // Should NOT have called setFixAwaitingApproval (the late write)
    expect(orchestrator.setFixAwaitingApproval).not.toHaveBeenCalled();
    // Should NOT have called revertConflictResolution either
    expect(orchestrator.revertConflictResolution).not.toHaveBeenCalled();
  });

  it('throws StaleLineageError when signal is aborted during async fix', async () => {
    const ac = new AbortController();
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: { error: 'boom', selectedAttemptId: 'att-1', generation: 5 },
      })),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      revertConflictResolution: vi.fn(),
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
    }, {
      signal: ac.signal,
    })).rejects.toThrow(StaleLineageError);

    expect(orchestrator.setFixAwaitingApproval).not.toHaveBeenCalled();
    expect(orchestrator.revertConflictResolution).not.toHaveBeenCalled();
  });

  it('skips revertConflictResolution when lineage changed and fix threw', async () => {
    let getTaskCallCount = 0;
    const orchestrator = {
      getTask: vi.fn(() => {
        getTaskCallCount++;
        if (getTaskCallCount <= 4) {
          return makeTask({
            status: 'failed',
            config: { workflowId: 'wf-1' },
            execution: { error: 'boom', selectedAttemptId: 'att-1', generation: 5 },
          });
        }
        // Lineage changed during fix
        return makeTask({
          status: 'pending',
          config: { workflowId: 'wf-1' },
          execution: { selectedAttemptId: 'att-2', generation: 6 },
        });
      }),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      revertConflictResolution: vi.fn(),
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
    })).rejects.toThrow(StaleLineageError);

    // revertConflictResolution must NOT be called when lineage is stale
    expect(orchestrator.revertConflictResolution).not.toHaveBeenCalled();
    expect(persistence.appendTaskOutput).not.toHaveBeenCalled();
  });

  it('proceeds normally when lineage is current', async () => {
    const orchestrator = {
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: { error: 'boom', selectedAttemptId: 'att-1', generation: 5 },
      })),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      revertConflictResolution: vi.fn(),
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
            execution: { error: mergeError, selectedAttemptId: 'att-1', generation: 5 },
          });
        }
        // Lineage changed
        return makeTask({
          status: 'pending',
          config: { workflowId: 'wf-1' },
          execution: { selectedAttemptId: 'att-2', generation: 6 },
        });
      }),
      beginConflictResolution: vi.fn(() => ({ savedError: mergeError })),
      setFixAwaitingApproval: vi.fn(),
      revertConflictResolution: vi.fn(),
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
    expect(orchestrator.revertConflictResolution).not.toHaveBeenCalled();
  });

  it('skips revertConflictResolution when lineage changed and resolution threw', async () => {
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
      beginConflictResolution: vi.fn(() => ({ savedError: 'merge err' })),
      setFixAwaitingApproval: vi.fn(),
      revertConflictResolution: vi.fn(),
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

    expect(orchestrator.revertConflictResolution).not.toHaveBeenCalled();
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
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => {
        getTaskCallCount++;
        if (getTaskCallCount <= 4) {
          return makeTask({
            status: 'failed',
            config: { workflowId: 'wf-1' },
            execution: {
              autoFixAttempts: 0,
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
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      retryTask: vi.fn(() => []),
      revertConflictResolution: vi.fn(),
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
    })).rejects.toThrow(StaleLineageError);

    expect(orchestrator.setFixAwaitingApproval).not.toHaveBeenCalled();
    expect(orchestrator.retryTask).not.toHaveBeenCalled();
  });

  it('skips revertConflictResolution on failure when lineage changed', async () => {
    let getTaskCallCount = 0;
    const orchestrator = {
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => {
        getTaskCallCount++;
        if (getTaskCallCount <= 4) {
          return makeTask({
            status: 'failed',
            config: { workflowId: 'wf-1' },
            execution: {
              autoFixAttempts: 0,
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
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      retryTask: vi.fn(() => []),
      revertConflictResolution: vi.fn(),
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
    })).rejects.toThrow(StaleLineageError);

    expect(orchestrator.revertConflictResolution).not.toHaveBeenCalled();
    expect(persistence.appendTaskOutput).not.toHaveBeenCalledWith(
      'task-a',
      expect.stringContaining('[Auto-fix] Agent failed'),
    );
  });

  it('throws StaleLineageError when signal is aborted during auto-fix', async () => {
    const ac = new AbortController();
    const orchestrator = {
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1' },
        execution: {
          autoFixAttempts: 0,
          error: 'boom',
          selectedAttemptId: 'att-1',
          generation: 5,
          workspacePath: '/tmp/task-a',
        },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      setFixAwaitingApproval: vi.fn(),
      retryTask: vi.fn(() => []),
      revertConflictResolution: vi.fn(),
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
        execution: { error: 'ci failed', ...execution },
      })),
      beginConflictResolution: vi.fn(() => ({ savedError: 'ci failed' })),
      setFixAwaitingApproval: vi.fn(),
      revertConflictResolution: vi.fn(),
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
    expect(orchestrator.beginConflictResolution).not.toHaveBeenCalled();
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
    expect(result).toEqual({ kind: 'fixWithAgent', autoApproved: false, started: [] });
  });
});
