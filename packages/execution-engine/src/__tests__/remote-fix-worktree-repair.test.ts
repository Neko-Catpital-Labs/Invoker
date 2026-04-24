import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fixWithAgentImpl } from '../conflict-resolver.js';
import type { ConflictResolverHost } from '../conflict-resolver.js';
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
        executorType: 'ssh' as const,
        remoteTargetId: 'remote-1',
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
});
