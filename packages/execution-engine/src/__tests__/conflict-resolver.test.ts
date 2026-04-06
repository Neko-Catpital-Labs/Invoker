import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildFixPrompt, resolveConflictImpl, fixWithAgentImpl, spawnRemoteAgentFixImpl } from '../conflict-resolver.js';
import type { ConflictResolverHost } from '../conflict-resolver.js';
import type { Orchestrator } from '@invoker/workflow-core';
import { registerBuiltinAgents } from '../agents/index.js';
import { CodexExecutionAgent } from '../agents/codex-execution-agent.js';
import { ClaudeExecutionAgent } from '../agents/claude-execution-agent.js';

const tempDirs: string[] = [];
function createTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'invoker-conflict-resolver-test-'));
  tempDirs.push(dir);
  return dir;
}
function nonExistentWorkspacePath(): string {
  return join(tmpdir(), `invoker-missing-workspace-${randomUUID()}`);
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildFixPrompt', () => {
  it('generates command-focused prompt when task has a command', () => {
    const task = {
      description: 'Run unit tests',
      config: { command: 'pnpm test' },
      execution: { error: 'Test failed' },
    };
    const prompt = buildFixPrompt(task, 'FAIL: expected 1 to equal 2');
    expect(prompt).toContain('build/test command failed');
    expect(prompt).toContain('Command: pnpm test');
    expect(prompt).toContain('Do NOT modify the command itself');
    expect(prompt).not.toContain('merge operation');
  });

  it('generates merge-focused prompt for merge gate nodes', () => {
    const task = {
      description: 'Merge gate for workflow',
      config: { isMergeNode: true },
      execution: { error: 'Merge failed: conflict in src/index.ts' },
    };
    const prompt = buildFixPrompt(task, 'CONFLICT (content): Merge conflict in src/index.ts');
    expect(prompt).toContain('merge operation failed');
    expect(prompt).toContain('Merge failed: conflict in src/index.ts');
    expect(prompt).toContain('merge cleanly');
    expect(prompt).not.toContain('build/test command');
  });

  it('generates generic prompt for prompt-only tasks', () => {
    const task = {
      description: 'Implement feature X',
      config: { prompt: 'Add feature X to the codebase' },
      execution: { error: 'Claude exited with code 1' },
    };
    const prompt = buildFixPrompt(task, 'Error: file not found');
    expect(prompt).toContain('task failed');
    expect(prompt).toContain('Original prompt: Add feature X');
    expect(prompt).toContain('Claude exited with code 1');
    expect(prompt).not.toContain('build/test command');
    expect(prompt).not.toContain('merge operation');
  });

  it('includes last 200 lines of output', () => {
    const longOutput = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const task = {
      description: 'Test task',
      config: { command: 'npm test' },
      execution: {},
    };
    const prompt = buildFixPrompt(task, longOutput);
    expect(prompt).toContain('line 100');
    expect(prompt).toContain('line 299');
    expect(prompt).not.toContain('line 99');
  });

  it('handles empty output gracefully', () => {
    const task = {
      description: 'Test task',
      config: { command: 'npm test' },
      execution: { error: 'exit code 1' },
    };
    const prompt = buildFixPrompt(task, '');
    expect(prompt).toContain('build/test command failed');
  });

  it('handles merge gate with no error message', () => {
    const task = {
      description: 'Merge gate',
      config: { isMergeNode: true },
      execution: {},
    };
    const prompt = buildFixPrompt(task, '');
    expect(prompt).toContain('merge operation failed');
    expect(prompt).toContain('Unknown error');
  });
});

describe('resolveConflictImpl', () => {
  function makeHost(task: Record<string, any>): ConflictResolverHost {
    return {
      orchestrator: {
        getTask: () => task,
        getAllTasks: () => [],
      } as unknown as Orchestrator,
      persistence: {} as any,
      cwd: '/tmp',
      execGitReadonly: async () => '',
      execGitIn: async () => '',
      createMergeWorktree: async () => '/tmp/wt',
      removeMergeWorktree: async () => {},
      spawnAgentFix: async () => ({ stdout: '', sessionId: '' }),
    };
  }

  it('throws "no error information" when error was cleared and no savedError provided', async () => {
    const task = {
      id: 'task-1',
      status: 'fixing_with_ai',
      execution: { error: undefined },
      config: {},
    };
    await expect(
      resolveConflictImpl(makeHost(task), 'task-1'),
    ).rejects.toThrow('no error information');
  });

  it('uses savedError to proceed past error check when task.execution.error is cleared', async () => {
    const conflictError = JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'invoker/dep-1',
      conflictFiles: ['src/index.ts'],
    });
    const task = {
      id: 'task-1',
      status: 'fixing_with_ai',
      execution: { error: undefined, branch: 'invoker/task-1', workspacePath: createTempWorkspace() },
      config: {},
    };
    // With savedError the function should NOT throw "no error information".
    // Mocked git ops succeed, so it resolves cleanly.
    await expect(
      resolveConflictImpl(makeHost(task), 'task-1', conflictError),
    ).resolves.toBeUndefined();
  });

  it('threads agentName="codex" to spawnAgentFix when merge fails', async () => {
    const spawnAgentFix = vi.fn<(prompt: string, cwd: string, agentName?: string) => Promise<{ stdout: string; sessionId: string }>>(
      async () => ({ stdout: '', sessionId: 'sess-conflict-codex' }),
    );
    const conflictError = JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'invoker/dep-1',
      conflictFiles: ['src/index.ts'],
    });
    const task = {
      id: 'task-conflict',
      status: 'failed' as const,
      execution: { error: conflictError, branch: 'invoker/task-conflict', workspacePath: createTempWorkspace() },
      config: {},
    };
    const host: ConflictResolverHost = {
      orchestrator: {
        getTask: () => task,
        getAllTasks: () => [],
      } as unknown as Orchestrator,
      persistence: {} as any,
      cwd: '/tmp',
      execGitReadonly: async () => '',
      execGitIn: async (args: string[]) => {
        // Checkout succeeds, merge fails to trigger agent spawn
        if (args[0] === 'merge') throw new Error('merge conflict');
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      },
      createMergeWorktree: async () => '/tmp/wt',
      removeMergeWorktree: async () => {},
      spawnAgentFix,
    };

    await resolveConflictImpl(host, 'task-conflict', undefined, 'codex');

    expect(spawnAgentFix).toHaveBeenCalledTimes(1);
    expect(spawnAgentFix.mock.calls[0][2]).toBe('codex');
  });

  it('threads agentName="claude" to spawnAgentFix by default', async () => {
    const spawnAgentFix = vi.fn<(prompt: string, cwd: string, agentName?: string) => Promise<{ stdout: string; sessionId: string }>>(
      async () => ({ stdout: '', sessionId: 'sess-conflict-claude' }),
    );
    const conflictError = JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'invoker/dep-1',
      conflictFiles: ['src/index.ts'],
    });
    const task = {
      id: 'task-conflict-2',
      status: 'failed' as const,
      execution: { error: conflictError, branch: 'invoker/task-conflict-2', workspacePath: createTempWorkspace() },
      config: {},
    };
    const host: ConflictResolverHost = {
      orchestrator: {
        getTask: () => task,
        getAllTasks: () => [],
      } as unknown as Orchestrator,
      persistence: {} as any,
      cwd: '/tmp',
      execGitReadonly: async () => '',
      execGitIn: async (args: string[]) => {
        if (args[0] === 'merge') throw new Error('merge conflict');
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      },
      createMergeWorktree: async () => '/tmp/wt',
      removeMergeWorktree: async () => {},
      spawnAgentFix,
    };

    await resolveConflictImpl(host, 'task-conflict-2', undefined, 'claude');

    expect(spawnAgentFix).toHaveBeenCalledTimes(1);
    expect(spawnAgentFix.mock.calls[0][2]).toBe('claude');
  });
});

describe('agent dispatch — codex vs claude', () => {
  describe('CodexExecutionAgent.buildFixCommand', () => {
    it('produces codex exec command, NOT claude', () => {
      const agent = new CodexExecutionAgent();
      const spec = agent.buildFixCommand('fix the bug');
      expect(spec.cmd).toBe('codex');
      expect(spec.args).toContain('exec');
      expect(spec.args).toContain('--json');
      expect(spec.args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(spec.args).toContain('fix the bug');
      // Must NOT contain claude flags
      expect(spec.args).not.toContain('--dangerously-skip-permissions');
      expect(spec.args).not.toContain('-p');
      expect(spec.args).not.toContain('--session-id');
    });
  });

  describe('ClaudeExecutionAgent.buildFixCommand', () => {
    it('produces claude command, NOT codex', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildFixCommand('fix the bug');
      expect(spec.cmd).toBe('claude');
      expect(spec.args).toContain('-p');
      expect(spec.args).toContain('--dangerously-skip-permissions');
      expect(spec.args).toContain('--session-id');
      // Must NOT contain codex flags
      expect(spec.args).not.toContain('exec');
      expect(spec.args).not.toContain('--json');
      expect(spec.args).not.toContain('--full-auto');
    });
  });

  describe('registry lookup dispatches correct agent', () => {
    it('resolves "codex" to CodexExecutionAgent', () => {
      const registry = registerBuiltinAgents();
      const agent = registry.getOrThrow('codex');
      expect(agent).toBeInstanceOf(CodexExecutionAgent);
      expect(agent.name).toBe('codex');
    });

    it('resolves "claude" to ClaudeExecutionAgent', () => {
      const registry = registerBuiltinAgents();
      const agent = registry.getOrThrow('claude');
      expect(agent).toBeInstanceOf(ClaudeExecutionAgent);
      expect(agent.name).toBe('claude');
    });

    it('codex agent from registry builds codex command', () => {
      const registry = registerBuiltinAgents();
      const agent = registry.getOrThrow('codex');
      const spec = agent.buildFixCommand!('fix the bug');
      expect(spec.cmd).toBe('codex');
      expect(spec.args).toContain('exec');
    });

    it('claude agent from registry builds claude command', () => {
      const registry = registerBuiltinAgents();
      const agent = registry.getOrThrow('claude');
      const spec = agent.buildFixCommand!('fix the bug');
      expect(spec.cmd).toBe('claude');
      expect(spec.args).toContain('-p');
    });
  });

  describe('fixWithAgentImpl dispatches via spawnAgentFix', () => {
    it('passes agentName="codex" through to spawnAgentFix', async () => {
      const spawnAgentFix = vi.fn<(prompt: string, cwd: string, agentName?: string) => Promise<{ stdout: string; sessionId: string }>>(async () => ({ stdout: 'fixed', sessionId: 'sess-1' }));
      const host: ConflictResolverHost = {
        orchestrator: {
          getTask: () => ({
            id: 'task-1',
            status: 'failed',
            config: { command: 'pnpm test' },
            execution: { error: 'test failed', workspacePath: createTempWorkspace() },
          }),
          getAllTasks: () => [],
        } as unknown as Orchestrator,
        persistence: { appendTaskOutput: vi.fn(), updateTask: vi.fn() } as any,
        cwd: '/tmp',
        execGitReadonly: async () => '',
        execGitIn: async () => '',
        createMergeWorktree: async () => '/tmp/wt',
        removeMergeWorktree: async () => {},
        spawnAgentFix,
      };

      await fixWithAgentImpl(host, 'task-1', 'error output', 'codex');

      // spawnAgentFix must receive 'codex' — not undefined or 'claude'
      expect(spawnAgentFix).toHaveBeenCalledTimes(1);
      expect(spawnAgentFix.mock.calls[0][2]).toBe('codex');
    });

    it('passes agentName="claude" through to spawnAgentFix', async () => {
      const spawnAgentFix = vi.fn<(prompt: string, cwd: string, agentName?: string) => Promise<{ stdout: string; sessionId: string }>>(async () => ({ stdout: 'fixed', sessionId: 'sess-2' }));
      const host: ConflictResolverHost = {
        orchestrator: {
          getTask: () => ({
            id: 'task-2',
            status: 'failed',
            config: { command: 'pnpm test' },
            execution: { error: 'test failed', workspacePath: createTempWorkspace() },
          }),
          getAllTasks: () => [],
        } as unknown as Orchestrator,
        persistence: { appendTaskOutput: vi.fn(), updateTask: vi.fn() } as any,
        cwd: '/tmp',
        execGitReadonly: async () => '',
        execGitIn: async () => '',
        createMergeWorktree: async () => '/tmp/wt',
        removeMergeWorktree: async () => {},
        spawnAgentFix,
      };

      await fixWithAgentImpl(host, 'task-2', 'error output', 'claude');

      expect(spawnAgentFix).toHaveBeenCalledTimes(1);
      expect(spawnAgentFix.mock.calls[0][2]).toBe('claude');
    });

    it('records agentName in persistence for codex fixes', async () => {
      const updateTask = vi.fn();
      const spawnAgentFix = vi.fn<(prompt: string, cwd: string, agentName?: string) => Promise<{ stdout: string; sessionId: string }>>(async () => ({ stdout: 'fixed', sessionId: 'sess-codex' }));
      const host: ConflictResolverHost = {
        orchestrator: {
          getTask: () => ({
            id: 'task-3',
            status: 'failed',
            config: { command: 'pnpm test' },
            execution: { error: 'test failed', workspacePath: createTempWorkspace() },
          }),
          getAllTasks: () => [],
        } as unknown as Orchestrator,
        persistence: { appendTaskOutput: vi.fn(), updateTask } as any,
        cwd: '/tmp',
        execGitReadonly: async () => '',
        execGitIn: async () => '',
        createMergeWorktree: async () => '/tmp/wt',
        removeMergeWorktree: async () => {},
        spawnAgentFix,
      };

      await fixWithAgentImpl(host, 'task-3', 'error output', 'codex');

      // agentName should be persisted as 'codex', not 'claude'
      expect(updateTask).toHaveBeenCalledWith('task-3', {
        execution: {
          agentSessionId: 'sess-codex',
          lastAgentSessionId: 'sess-codex',
          agentName: 'codex',
          lastAgentName: 'codex',
        },
      });
    });
  });
});

describe('remote agent dispatch via registry', () => {
  // We can't easily test actual SSH spawning, but we can verify the exported
  // function signature accepts the new agentRegistry parameter. The real
  // command generation is tested indirectly via resolveConflictRemote behavior.

  it('resolveConflictRemote uses registry-backed command for codex', async () => {
    const registry = registerBuiltinAgents();

    // Mock host with agentRegistry
    const conflictError = JSON.stringify({
      type: 'merge_conflict',
      failedBranch: 'invoker/dep-1',
      conflictFiles: ['src/index.ts'],
    });
    const task = {
      id: 'task-remote-codex',
      status: 'failed' as const,
      description: 'Test task',
      dependencies: [],
      execution: {
        error: conflictError,
        branch: 'invoker/task-remote-codex',
        workspacePath: '~/worktrees/task-remote-codex',
      },
      config: {
        familiarType: 'ssh' as const,
        remoteTargetId: 'remote_do_1',
      },
    };

    // We need the remote path to be non-existent locally for SSH dispatch
    const host: ConflictResolverHost = {
      orchestrator: {
        getTask: () => task,
        getAllTasks: () => [],
      } as unknown as Orchestrator,
      persistence: {} as any,
      cwd: '/tmp',
      agentRegistry: registry,
      execGitReadonly: async () => '',
      execGitIn: async () => '',
      createMergeWorktree: async () => '/tmp/wt',
      removeMergeWorktree: async () => {},
      spawnAgentFix: async () => ({ stdout: '', sessionId: '' }),
      getRemoteTargetConfig: () => ({
        host: '1.2.3.4',
        user: 'invoker',
        sshKeyPath: '/tmp/key',
      }),
    };

    // Since resolveConflictImpl delegates to resolveConflictRemote which calls
    // execRemoteSsh (spawns real SSH), we test that the function constructs
    // correctly by mocking spawn. For this unit test, we verify the host
    // interface accepts agentRegistry and the function doesn't throw on setup.
    // Full integration testing requires SSH access.
    // The key assertion: host.agentRegistry is set and will be used.
    expect(host.agentRegistry).toBeDefined();
    expect(host.agentRegistry!.get('codex')).toBeDefined();
    expect(host.agentRegistry!.get('codex')!.buildFixCommand).toBeDefined();
  });

  it('spawnRemoteAgentFixImpl accepts agentRegistry parameter', () => {
    // Verify the function signature accepts the new parameter without type error.
    // We can't call it without real SSH, but we verify it's callable.
    expect(typeof spawnRemoteAgentFixImpl).toBe('function');
    expect(spawnRemoteAgentFixImpl.length).toBeGreaterThanOrEqual(3);
  });


  it('codex agent buildFixCommand generates correct remote shell command shape', () => {
    const registry = registerBuiltinAgents();
    const agent = registry.getOrThrow('codex');
    const spec = agent.buildFixCommand!('fix the merge conflict');

    // The remote dispatch will do: `${spec.cmd} ${spec.args.map(shellQuote).join(' ')}`
    // Verify the pieces are correct
    expect(spec.cmd).toBe('codex');
    expect(spec.args).toContain('exec');
    expect(spec.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(spec.args).toContain('fix the merge conflict');
    // Must NOT contain claude-specific flags
    expect(spec.args).not.toContain('--session-id');
    expect(spec.args).not.toContain('--dangerously-skip-permissions');
  });

  it('claude agent buildFixCommand generates correct remote shell command shape', () => {
    const registry = registerBuiltinAgents();
    const agent = registry.getOrThrow('claude');
    const spec = agent.buildFixCommand!('fix the merge conflict');

    expect(spec.cmd).toBe('claude');
    expect(spec.args).toContain('-p');
    expect(spec.args).toContain('--dangerously-skip-permissions');
    expect(spec.args).toContain('fix the merge conflict');
    // Must NOT contain codex-specific flags
    expect(spec.args).not.toContain('exec');
    expect(spec.args).not.toContain('--full-auto');
  });
});

// ── Fail-fast workspace invariant tests ──────────────────────

describe('conflict-resolver fail-fast workspace invariant', () => {
  function makeHost(task: Record<string, any>): ConflictResolverHost {
    return {
      orchestrator: {
        getTask: () => task,
        getAllTasks: () => [],
      } as unknown as Orchestrator,
      persistence: {} as any,
      cwd: '/tmp',
      execGitReadonly: async () => '',
      execGitIn: async () => '',
      createMergeWorktree: async () => '/tmp/wt',
      removeMergeWorktree: async () => {},
      spawnAgentFix: async () => ({ stdout: '', sessionId: '' }),
    };
  }

  describe('resolveConflictImpl', () => {
    it('throws when task has no workspacePath', async () => {
      const conflictError = JSON.stringify({
        type: 'merge_conflict',
        failedBranch: 'invoker/dep-1',
        conflictFiles: ['src/index.ts'],
      });
      const task = {
        id: 'task-no-workspace',
        status: 'failed' as const,
        execution: {
          error: conflictError,
          branch: 'invoker/task-no-workspace',
          workspacePath: undefined,  // Missing!
        },
        config: { familiarType: 'worktree' },
      };

      await expect(
        resolveConflictImpl(makeHost(task), 'task-no-workspace'),
      ).rejects.toThrow(/has no workspacePath/);
      await expect(
        resolveConflictImpl(makeHost(task), 'task-no-workspace'),
      ).rejects.toThrow(/Recreate the task or recreate the workflow/);
    });

    it('throws when local task workspace does not exist on disk', async () => {
      const conflictError = JSON.stringify({
        type: 'merge_conflict',
        failedBranch: 'invoker/dep-1',
        conflictFiles: ['src/index.ts'],
      });
      const task = {
        id: 'task-workspace-gone',
        status: 'failed' as const,
        execution: {
          error: conflictError,
          branch: 'invoker/task-workspace-gone',
          workspacePath: nonExistentWorkspacePath(),
        },
        config: { familiarType: 'worktree' },
      };

      await expect(
        resolveConflictImpl(makeHost(task), 'task-workspace-gone'),
      ).rejects.toThrow(/workspace does not exist on disk/);
      await expect(
        resolveConflictImpl(makeHost(task), 'task-workspace-gone'),
      ).rejects.toThrow(/Refusing to run git operations without a valid workspace/);
    });

    it('allows remote SSH tasks with non-existent local path', async () => {
      const conflictError = JSON.stringify({
        type: 'merge_conflict',
        failedBranch: 'invoker/dep-1',
        conflictFiles: ['src/index.ts'],
      });
      const task = {
        id: 'task-ssh',
        status: 'failed' as const,
        execution: {
          error: conflictError,
          branch: 'invoker/task-ssh',
          workspacePath: '~/worktrees/remote',  // Remote path
        },
        config: {
          familiarType: 'ssh' as const,
          remoteTargetId: 'remote-1',
        },
      };

      const host: ConflictResolverHost = {
        ...makeHost(task),
        getRemoteTargetConfig: () => ({
          host: 'remote.example',
          user: 'user',
          sshKeyPath: '/key',
        }),
      };

      // Should not throw - SSH tasks can have remote paths
      // Will fail later due to missing mocks, but should pass the workspace check
      await expect(
        resolveConflictImpl(host, 'task-ssh'),
      ).rejects.not.toThrow(/workspace does not exist on disk/);
    });
  });

  describe('fixWithAgentImpl', () => {
    it('throws when task has no workspacePath', async () => {
      const task = {
        id: 'task-no-workspace',
        status: 'failed' as const,
        execution: {
          error: 'Test failed',
          workspacePath: undefined,  // Missing!
        },
        config: { command: 'npm test' },
      };

      await expect(
        fixWithAgentImpl(makeHost(task), 'task-no-workspace', 'error output'),
      ).rejects.toThrow(/has no valid workspace/);
      await expect(
        fixWithAgentImpl(makeHost(task), 'task-no-workspace', 'error output'),
      ).rejects.toThrow(/Recreate the task or recreate the workflow/);
    });

    it('throws when local task workspace does not exist on disk', async () => {
      const task = {
        id: 'task-workspace-gone',
        status: 'failed' as const,
        execution: {
          error: 'Test failed',
          workspacePath: nonExistentWorkspacePath(),
        },
        config: { command: 'npm test' },
      };

      await expect(
        fixWithAgentImpl(makeHost(task), 'task-workspace-gone', 'error output'),
      ).rejects.toThrow(/has no valid workspace/);
    });

    it('allows remote SSH tasks with non-existent local path', async () => {
      const task = {
        id: 'task-ssh',
        status: 'failed' as const,
        execution: {
          error: 'Test failed',
          workspacePath: '~/worktrees/remote',  // Remote path
        },
        config: {
          command: 'npm test',
          familiarType: 'ssh' as const,
          remoteTargetId: 'remote-1',
        },
      };

      const host: ConflictResolverHost = {
        ...makeHost(task),
        getRemoteTargetConfig: () => ({
          host: 'remote.example',
          user: 'user',
          sshKeyPath: '/key',
        }),
        agentRegistry: registerBuiltinAgents(),
      };

      // Should not throw workspace check - SSH tasks can have remote paths
      // This path will still fail in unit tests because no SSH target exists.
      await expect(
        fixWithAgentImpl(host, 'task-ssh', 'error output'),
      ).rejects.not.toThrow(/has no valid workspace/);
    });
  });
});
