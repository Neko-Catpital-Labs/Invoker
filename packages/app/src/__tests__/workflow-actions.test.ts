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
  restartTask,
  approveTask,
  rejectTask,
  provideInput,
  editTaskCommand,
  editTaskType,
  selectExperiment,
  setWorkflowMergeMode,
  finalizeAppliedFix,
  autoFixOnFailure,
} from '../workflow-actions.js';

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

describe('restartTask', () => {
  it('calls orchestrator.restartTask and returns result', () => {
    const tasks = [makeRunningTask()];
    const orchestrator = { restartTask: vi.fn(() => tasks) };

    const result = restartTask('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(orchestrator.restartTask).toHaveBeenCalledWith('task-a');
    expect(result).toBe(tasks);
  });
});

describe('approveTask', () => {
  it('calls orchestrator.approve and returns result', async () => {
    const tasks = [makeRunningTask()];
    const orchestrator = { approve: vi.fn().mockResolvedValue(tasks) };

    const result = await approveTask('task-a', {
      orchestrator: orchestrator as unknown as Orchestrator,
    });

    expect(orchestrator.approve).toHaveBeenCalledWith('task-a');
    expect(result).toBe(tasks);
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

  it('auto-approves and executes runnable tasks when enabled', async () => {
    const started = [
      makeRunningTask({ id: 'task-a', config: { workflowId: 'wf-1' } }),
    ];
    const orchestrator = {
      setFixAwaitingApproval: vi.fn(),
      approve: vi.fn().mockResolvedValue(started),
    };
    const taskExecutor = {
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
    expect(taskExecutor.executeTasks).toHaveBeenCalledWith(started);
    expect(taskExecutor.publishAfterFix).not.toHaveBeenCalled();
  });

  it('auto-approves and publishes post-fix merge gates when enabled', async () => {
    const started = [
      makeRunningTask({ id: 'merge-a', config: { workflowId: 'wf-1', isMergeNode: true } }),
    ];
    const orchestrator = {
      setFixAwaitingApproval: vi.fn(),
      approve: vi.fn().mockResolvedValue(started),
    };
    const taskExecutor = {
      publishAfterFix: vi.fn(),
      executeTasks: vi.fn(),
    };

    await finalizeAppliedFix('merge-a', 'saved-error', {
      orchestrator: orchestrator as unknown as Orchestrator,
      taskExecutor: taskExecutor as unknown as TaskRunner,
      autoApproveAIFixes: true,
    });

    expect(taskExecutor.publishAfterFix).toHaveBeenCalledWith(started[0]);
    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
  });
});

describe('autoFixOnFailure', () => {
  it('uses fixWithAgent for non-merge failures and restarts the task directly', async () => {
    const started = [makeRunningTask({ id: 'task-a', status: 'running' })];
    const orchestrator = {
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        execution: { autoFixAttempts: 0 },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      restartTask: vi.fn(() => started),
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
    expect(orchestrator.restartTask).toHaveBeenCalledWith('task-a');
    expect(taskExecutor.executeTasks).toHaveBeenCalledWith(started);
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
        execution: { autoFixAttempts: 0 },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: mergeError })),
      restartTask: vi.fn(() => started),
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
    expect(orchestrator.restartTask).toHaveBeenCalledWith('task-a');
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
        execution: { autoFixAttempts: 0 },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: mergeError })),
      restartTask: vi.fn(() => started),
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
      restartTask: vi.fn(() => []),
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
    expect(orchestrator.restartTask).not.toHaveBeenCalled();
    expect(taskExecutor.publishAfterFix).toHaveBeenCalledWith(started[0]);
  });

  it('retries inline when merge post-fix publish fails during auto-fix dispatch', async () => {
    const started = [
      makeRunningTask({ id: 'merge-a', config: { workflowId: 'wf-1', isMergeNode: true } }),
    ];
    const getTask = vi
      .fn()
      .mockReturnValueOnce(makeTask({
        id: 'merge-a',
        status: 'failed',
        config: { workflowId: 'wf-1', isMergeNode: true },
        execution: { autoFixAttempts: 0, workspacePath: '/tmp/merge-a' },
      }))
      .mockReturnValueOnce(makeTask({
        id: 'merge-a',
        status: 'failed',
        config: { workflowId: 'wf-1', isMergeNode: true },
        execution: { autoFixAttempts: 1, workspacePath: '/tmp/merge-a', error: 'Post-fix PR prep failed: conflict' },
      }))
      .mockReturnValueOnce(makeTask({
        id: 'merge-a',
        status: 'failed',
        config: { workflowId: 'wf-1', isMergeNode: true },
        execution: { autoFixAttempts: 1, workspacePath: '/tmp/merge-a' },
      }))
      .mockReturnValue(makeTask({
        id: 'merge-a',
        status: 'awaiting_approval',
        config: { workflowId: 'wf-1', isMergeNode: true },
        execution: { autoFixAttempts: 2, workspacePath: '/tmp/merge-a' },
      }));
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
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      restartTask: vi.fn(() => []),
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
    expect(orchestrator.restartTask).not.toHaveBeenCalled();
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
        execution: { autoFixAttempts: 0 },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      restartTask: vi.fn(() => started),
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

  it('uses task executionAgent when config.autoFixAgent is empty', async () => {
    const started = [makeRunningTask({ id: 'task-a', status: 'running' })];
    const logEvent = vi.fn();
    const orchestrator = {
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => makeTask({
        status: 'failed',
        config: { workflowId: 'wf-1', executionAgent: 'codex' },
        execution: { autoFixAttempts: 0 },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: 'boom' })),
      restartTask: vi.fn(() => started),
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

    expect(taskExecutor.fixWithAgent).toHaveBeenCalledWith('task-a', 'test output', 'codex', 'boom');
    expect(logEvent).toHaveBeenCalledWith(
      'task-a',
      'debug.auto-fix',
      expect.objectContaining({
        phase: 'auto-fix-agent-selected',
        selectedAgent: 'codex',
        selectedAgentSource: 'task',
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
        execution: { autoFixAttempts: 0 },
      })),
      getAutoFixRetryBudget: vi.fn(() => 3),
      beginConflictResolution: vi.fn(() => ({ savedError: mergeError })),
      restartTask: vi.fn(() => started),
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

  it('passes remoteTargetId when provided', () => {
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
  let orchestrator: { restartTask: ReturnType<typeof vi.fn> };
  let persistence: {
    updateWorkflow: ReturnType<typeof vi.fn>;
    loadTasks: ReturnType<typeof vi.fn>;
  };
  let taskExecutor: { executeTasks: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    orchestrator = {
      restartTask: vi.fn(() => [makeRunningTask({ id: 'merge-task', config: { isMergeNode: true } })]),
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

  it('updates persistence with canonical mode', async () => {
    await setWorkflowMergeMode('wf-1', 'external_review', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(persistence.updateWorkflow).toHaveBeenCalledWith('wf-1', { mergeMode: 'external_review' });
  });

  it('restarts merge node when it is completed', async () => {
    await setWorkflowMergeMode('wf-1', 'automatic', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(orchestrator.restartTask).toHaveBeenCalledWith('merge-task');
    expect(taskExecutor.executeTasks).toHaveBeenCalled();
  });

  it('restarts merge node when it is awaiting_approval', async () => {
    persistence.loadTasks.mockReturnValue([
      makeTask({ id: 'merge-task', status: 'awaiting_approval', config: { isMergeNode: true } }),
    ]);

    await setWorkflowMergeMode('wf-1', 'manual', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(orchestrator.restartTask).toHaveBeenCalledWith('merge-task');
  });

  it('does not restart merge node when it is pending', async () => {
    persistence.loadTasks.mockReturnValue([
      makeTask({ id: 'merge-task', status: 'pending', config: { isMergeNode: true } }),
    ]);

    await setWorkflowMergeMode('wf-1', 'manual', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(orchestrator.restartTask).not.toHaveBeenCalled();
    expect(taskExecutor.executeTasks).not.toHaveBeenCalled();
  });

  it('does not restart when no merge node exists', async () => {
    persistence.loadTasks.mockReturnValue([makeTask({ id: 'task-a', status: 'completed' })]);

    await setWorkflowMergeMode('wf-1', 'manual', {
      orchestrator: orchestrator as unknown as Orchestrator,
      persistence: persistence as unknown as SQLiteAdapter,
      taskExecutor: taskExecutor as unknown as TaskRunner,
    });

    expect(orchestrator.restartTask).not.toHaveBeenCalled();
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
