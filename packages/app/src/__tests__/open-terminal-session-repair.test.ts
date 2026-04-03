import { describe, it, expect, vi } from 'vitest';
import type { PersistedTaskMeta } from '@invoker/executors';
import { repairCodexResumeSessionMeta, type OpenTerminalPersistence } from '../open-terminal-for-task.js';

describe('repairCodexResumeSessionMeta', () => {
  it('repairs stale codex session from attempt history and backfills task/attempt', () => {
    const stale = 'stale-uuid';
    const recovered = 'real-codex-thread-id';
    const updateTask = vi.fn();
    const updateAttempt = vi.fn();

    const persistence: OpenTerminalPersistence = {
      getTaskStatus: () => 'completed',
      getFamiliarType: () => 'worktree',
      getAgentSessionId: () => stale,
      getContainerId: () => null,
      getWorkspacePath: () => '/tmp/wt',
      getBranch: () => 'experiment/task',
      loadAttempts: () => [
        { id: 'attempt-older', agentSessionId: recovered },
        { id: 'attempt-newest', agentSessionId: stale },
      ],
      updateTask,
      updateAttempt,
    };

    const driver = {
      loadSession: (sid: string) => (sid === recovered ? '{"ok":true}' : null),
      processOutput: () => '',
      parseSession: () => [],
    };
    const registry = {
      getSessionDriver: (agent: string) => (agent === 'codex' ? driver : undefined),
    } as any;

    const meta: PersistedTaskMeta = {
      taskId: 'wf-1/task-a',
      familiarType: 'worktree',
      agentSessionId: stale,
      executionAgent: 'codex',
      workspacePath: '/tmp/wt',
      branch: 'experiment/task',
    };

    const out = repairCodexResumeSessionMeta(meta, persistence, registry);
    expect(out.agentSessionId).toBe(recovered);
    expect(updateTask).toHaveBeenCalledWith('wf-1/task-a', {
      execution: { agentSessionId: recovered, lastAgentSessionId: recovered },
    });
    expect(updateAttempt).toHaveBeenCalledWith('attempt-newest', { agentSessionId: recovered });
  });

  it('drops stale codex session when no saved session can be recovered', () => {
    const stale = 'stale-uuid';
    const updateTask = vi.fn();
    const updateAttempt = vi.fn();

    const persistence: OpenTerminalPersistence = {
      getTaskStatus: () => 'completed',
      getFamiliarType: () => 'worktree',
      getAgentSessionId: () => stale,
      getContainerId: () => null,
      getWorkspacePath: () => '/tmp/wt',
      getBranch: () => 'experiment/task',
      loadAttempts: () => [{ id: 'attempt-1', agentSessionId: 'also-missing' }],
      updateTask,
      updateAttempt,
    };

    const driver = {
      loadSession: () => null,
      processOutput: () => '',
      parseSession: () => [],
    };
    const registry = {
      getSessionDriver: () => driver,
    } as any;

    const meta: PersistedTaskMeta = {
      taskId: 'wf-1/task-a',
      familiarType: 'worktree',
      agentSessionId: stale,
      executionAgent: 'codex',
      workspacePath: '/tmp/wt',
      branch: 'experiment/task',
    };

    const out = repairCodexResumeSessionMeta(meta, persistence, registry);
    expect(out.agentSessionId).toBeUndefined();
    expect(updateTask).not.toHaveBeenCalled();
    expect(updateAttempt).not.toHaveBeenCalled();
  });

  it('keeps valid codex session unchanged', () => {
    const valid = 'real-thread';
    const persistence: OpenTerminalPersistence = {
      getTaskStatus: () => 'completed',
      getFamiliarType: () => 'worktree',
      getAgentSessionId: () => valid,
      getContainerId: () => null,
      getWorkspacePath: () => '/tmp/wt',
      getBranch: () => 'experiment/task',
    };

    const driver = {
      loadSession: () => '{"ok":true}',
      processOutput: () => '',
      parseSession: () => [],
    };
    const registry = { getSessionDriver: () => driver } as any;

    const meta: PersistedTaskMeta = {
      taskId: 'wf-1/task-a',
      familiarType: 'worktree',
      agentSessionId: valid,
      executionAgent: 'codex',
      workspacePath: '/tmp/wt',
      branch: 'experiment/task',
    };

    const out = repairCodexResumeSessionMeta(meta, persistence, registry);
    expect(out.agentSessionId).toBe(valid);
  });
});
