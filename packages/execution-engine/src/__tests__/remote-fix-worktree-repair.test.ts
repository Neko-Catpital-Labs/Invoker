import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fixWithAgentImpl } from '../conflict-resolver.js';
import type { ConflictResolverHost } from '../conflict-resolver.js';
import { TaskRunner } from '../task-runner.js';
import { SshExecutor } from '../ssh-executor.js';
import type { Orchestrator } from '@invoker/workflow-core';
import { registerBuiltinAgents } from '../agents/index.js';

vi.mock('node:child_process');

function mockSshChild(stdoutData: string, exitCode: number) {
  const { EventEmitter } = require('events');
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  (child as any).stdout = stdout;
  (child as any).stderr = stderr;
  (child as any).stdin = { write: vi.fn(), end: vi.fn() };

  setTimeout(() => {
    if (stdoutData) stdout.emit('data', Buffer.from(stdoutData));
    child.emit('close', exitCode);
  }, 0);

  return child;
}

describe('fixWithAgentImpl remote worktree repair', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeHost(task: Record<string, any>) {
    const updateTask = vi.fn();
    const appendTaskOutput = vi.fn();
    const logEvent = vi.fn();
    const host: ConflictResolverHost = {
      orchestrator: {
        getTask: () => task,
        getAllTasks: () => [],
      } as unknown as Orchestrator,
      persistence: {
        updateTask,
        appendTaskOutput,
        logEvent,
      } as any,
      cwd: '/tmp',
      execGitReadonly: async () => '',
      execGitIn: async () => '',
      createMergeWorktree: async () => '/tmp/wt',
      removeMergeWorktree: async () => {},
      spawnAgentFix: async () => ({ stdout: '', sessionId: '' }),
      getRemoteTargetConfig: () => ({
        host: 'remote.example',
        user: 'invoker',
        sshKeyPath: '/tmp/key',
        remoteInvokerHome: '/home/invoker/.invoker',
        managedWorkspaces: true,
      }),
      agentRegistry: registerBuiltinAgents(),
    };
    return { host, updateTask, appendTaskOutput, logEvent };
  }

  it('repairs the remote workspace path from branch ownership before spawning the fix session', async () => {
    const { spawn } = await import('node:child_process');
    const stalePath = '/home/invoker/.invoker/worktrees/049de5b865cc/experiment-wf-1-test-execution-engine-b68b146f';
    const ownerPath = '/home/invoker/.invoker/worktrees/049de5b865cc/experiment-wf-1-test-execution-engine-bc7a0b71';
    const branch = 'experiment/wf-1/test-execution-engine-b68b146f';
    const task = {
      id: 'wf-1/test-execution-engine',
      status: 'failed' as const,
      execution: {
        error: 'Test failed',
        workspacePath: stalePath,
        branch,
      },
      config: {
        command: 'pnpm test',
        runnerKind: 'ssh' as const,
        poolMemberId: 'remote-1',
      },
    };

    const { host, updateTask, appendTaskOutput } = makeHost(task);
    const firstChild = mockSshChild(
      `worktree ${ownerPath}
HEAD deadbeef
branch refs/heads/${branch}
`,
      0,
    );
    const secondChild = mockSshChild('Codex session: real-session-123\nremote fix applied', 0);
    vi.mocked(spawn)
      .mockReturnValueOnce(firstChild as any)
      .mockReturnValueOnce(secondChild as any);

    await fixWithAgentImpl(host, task.id, 'error output', 'codex');

    expect(updateTask).toHaveBeenCalledWith(task.id, {
      execution: {
        workspacePath: ownerPath,
      },
    });
    expect(updateTask).toHaveBeenCalledWith(task.id, {
      execution: {
        agentSessionId: expect.any(String),
        lastAgentSessionId: expect.any(String),
        agentName: 'codex',
        lastAgentName: 'codex',
      },
    });
    const remoteFixScript = ((secondChild as any).stdin.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(remoteFixScript).toContain(`WT="${ownerPath}"`);
    expect(appendTaskOutput).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining('[Fix with codex (remote)] Output:'),
    );
  });

  it('uses the resolved OMP model for repaired remote fix sessions', async () => {
    const { spawn } = await import('node:child_process');
    const stalePath = '/home/invoker/.invoker/worktrees/049de5b865cc/experiment-wf-1-test-execution-engine-b68b146f';
    const ownerPath = '/home/invoker/.invoker/worktrees/049de5b865cc/experiment-wf-1-test-execution-engine-bc7a0b71';
    const branch = 'experiment/wf-1/test-execution-engine-b68b146f';
    const task = {
      id: 'wf-1/test-execution-engine-omp',
      status: 'failed' as const,
      execution: {
        error: 'Test failed',
        workspacePath: stalePath,
        branch,
      },
      config: {
        command: 'pnpm test',
        runnerKind: 'ssh' as const,
        poolMemberId: 'remote-1',
        executionAgent: 'omp',
        executionModel: 'anthropic/claude-opus-4',
      },
    };

    const { host } = makeHost(task);
    const buildFixCommand = vi.fn((prompt: string, options?: { executionModel?: string }) => ({
      cmd: 'omp',
      args: ['--model', options?.executionModel ?? 'missing', '-p', prompt],
      sessionId: 'omp-session',
    }));
    Object.assign(host, {
      agentRegistry: {
        get: () => ({ name: 'omp', buildFixCommand }),
        getOrThrow: () => ({ name: 'omp', buildFixCommand }),
        getSessionDriver: () => undefined,
      },
    });
    const firstChild = mockSshChild(
      `worktree ${ownerPath}
HEAD deadbeef
branch refs/heads/${branch}
`,
      0,
    );
    const secondChild = mockSshChild('OMP session: real-session-123\nremote fix applied', 0);
    vi.mocked(spawn)
      .mockReturnValueOnce(firstChild as any)
      .mockReturnValueOnce(secondChild as any);

    await fixWithAgentImpl(host, task.id, 'error output', 'omp');

    expect(buildFixCommand).toHaveBeenCalledWith(
      expect.stringContaining('Fix the underlying code issue.'),
      { executionModel: 'anthropic/claude-opus-4' },
    );
  });
  it('repairs the remote workspace path before publishing an approved fix', async () => {
    const { spawn } = await import('node:child_process');
    const stalePath = '/home/invoker/.invoker/worktrees/049de5b865cc/experiment-wf-1-test-execution-engine-b68b146f';
    const ownerPath = '/home/invoker/.invoker/worktrees/049de5b865cc/experiment-wf-1-test-execution-engine-bc7a0b71';
    const branch = 'experiment/wf-1/test-execution-engine-b68b146f';
    const task = {
      id: 'wf-1/test-execution-engine',
      description: 'Fix execution engine',
      status: 'awaiting_approval' as const,
      execution: {
        workspacePath: stalePath,
        branch,
        selectedAttemptId: 'attempt-1',
      },
      config: {
        command: 'pnpm test',
        runnerKind: 'ssh' as const,
        poolMemberId: 'remote-1',
      },
    };
    const updateTask = vi.fn();
    const updateAttempt = vi.fn();
    const logEvent = vi.fn();
    const runner = new TaskRunner({
      orchestrator: { getTask: () => task } as any,
      persistence: { updateTask, updateAttempt, logEvent } as any,
      executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, register: () => {}, getAll: () => [] } as any,
      cwd: '/tmp',
      remoteTargetsProvider: () => ({
        'remote-1': {
          host: 'remote.example',
          user: 'invoker',
          sshKeyPath: '/tmp/key',
          remoteInvokerHome: '/home/invoker/.invoker',
          managedWorkspaces: true,
        },
      }),
    });
    const publishSpy = vi.spyOn(SshExecutor.prototype, 'publishApprovedFix').mockResolvedValue({
      commitHash: 'deadbeef',
    });
    const listChild = mockSshChild(
      `worktree ${ownerPath}
HEAD deadbeef
branch refs/heads/${branch}
`,
      0,
    );
    vi.mocked(spawn).mockReturnValueOnce(listChild as any);

    await runner.publishApprovedFix(task as any);

    expect(updateTask).toHaveBeenCalledWith(task.id, {
      execution: {
        workspacePath: ownerPath,
      },
    });
    expect(logEvent).toHaveBeenCalledWith(task.id, 'debug.approved-fix', {
      phase: 'publish-approved-fix-remote-path-repaired',
      previousWorkspacePath: stalePath,
      repairedWorkspacePath: ownerPath,
    });
    expect(publishSpy).toHaveBeenCalledWith(
      ownerPath,
      expect.objectContaining({ actionId: task.id }),
      branch,
    );
    expect(updateTask).toHaveBeenCalledWith(task.id, {
      execution: { commit: 'deadbeef' },
    });
    expect(updateAttempt).toHaveBeenCalledWith('attempt-1', {
      branch,
      commit: 'deadbeef',
    });
  });
});
