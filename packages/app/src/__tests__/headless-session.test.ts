import { describe, it, expect, vi } from 'vitest';
import { resolveAgentSession } from '../headless.js';
import type { AgentRegistry } from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

/**
 * Mock config module so resolveAgentSession can import loadConfig().
 */
vi.mock('../config.js', () => ({
  loadConfig: () => ({
    remoteTargets: {
      remote_do_1: { host: '1.2.3.4', user: 'invoker', sshKeyPath: '/tmp/key' },
    },
  }),
}));

function makeSshTask(overrides: Partial<TaskState['config']> = {}): TaskState {
  return {
    id: 'wf-1/ssh-task',
    description: 'SSH task',
    status: 'completed',
    dependencies: [],
    config: {
      familiarType: 'ssh',
      ...overrides,
    },
    execution: {
      agentSessionId: 'sess-abc',
      agentName: 'codex',
    },
  } as unknown as TaskState;
}

describe('resolveAgentSession', () => {
  it('returns null when no driver is registered', async () => {
    const result = await resolveAgentSession('sess-abc', 'unknown', undefined);
    expect(result).toBeNull();
  });

  it('returns local session when loadSession succeeds', async () => {
    const mockDriver = {
      processOutput: vi.fn(),
      loadSession: vi.fn(() => '{"messages":[]}'),
      parseSession: vi.fn(() => [{ role: 'assistant', content: 'hello' }]),
    };
    const registry = {
      getSessionDriver: () => mockDriver,
    } as unknown as AgentRegistry;

    const result = await resolveAgentSession('sess-abc', 'codex', registry);
    expect(result).toEqual([{ role: 'assistant', content: 'hello' }]);
    expect(mockDriver.loadSession).toHaveBeenCalledWith('sess-abc');
  });

  it('falls back to first remote target when SSH task has no remoteTargetId', async () => {
    const mockDriver = {
      processOutput: vi.fn(),
      loadSession: vi.fn(() => null), // not found locally
      parseSession: vi.fn(() => [{ role: 'assistant', content: 'remote session' }]),
      fetchRemoteSession: vi.fn(async () => '{"messages":[]}'),
    };
    const registry = {
      getSessionDriver: () => mockDriver,
    } as unknown as AgentRegistry;

    // SSH task without remoteTargetId
    const task = makeSshTask({ remoteTargetId: undefined });
    const result = await resolveAgentSession('sess-abc', 'codex', registry, [task]);

    expect(mockDriver.fetchRemoteSession).toHaveBeenCalledWith(
      'sess-abc',
      { host: '1.2.3.4', user: 'invoker', sshKeyPath: '/tmp/key' },
    );
    expect(result).toEqual([{ role: 'assistant', content: 'remote session' }]);
  });

  it('uses explicit remoteTargetId when present', async () => {
    const mockDriver = {
      processOutput: vi.fn(),
      loadSession: vi.fn(() => null),
      parseSession: vi.fn(() => [{ role: 'assistant', content: 'targeted' }]),
      fetchRemoteSession: vi.fn(async () => '{"messages":[]}'),
    };
    const registry = {
      getSessionDriver: () => mockDriver,
    } as unknown as AgentRegistry;

    const task = makeSshTask({ remoteTargetId: 'remote_do_1' });
    const result = await resolveAgentSession('sess-abc', 'codex', registry, [task]);

    expect(mockDriver.fetchRemoteSession).toHaveBeenCalledWith(
      'sess-abc',
      { host: '1.2.3.4', user: 'invoker', sshKeyPath: '/tmp/key' },
    );
    expect(result).toEqual([{ role: 'assistant', content: 'targeted' }]);
  });

  it('returns null when SSH task has no remoteTargetId and no targets configured', async () => {
    // Override mock for this test
    const configModule = await import('../config.js');
    const loadConfigSpy = vi.spyOn(configModule, 'loadConfig').mockReturnValue({
      remoteTargets: {},
    } as any);

    const mockDriver = {
      processOutput: vi.fn(),
      loadSession: vi.fn(() => null),
      parseSession: vi.fn(),
      fetchRemoteSession: vi.fn(),
    };
    const registry = {
      getSessionDriver: () => mockDriver,
    } as unknown as AgentRegistry;

    const task = makeSshTask({ remoteTargetId: undefined });
    const result = await resolveAgentSession('sess-abc', 'codex', registry, [task]);

    // fetchRemoteSession should NOT be called because there's no target
    expect(mockDriver.fetchRemoteSession).not.toHaveBeenCalled();
    expect(result).toBeNull();

    loadConfigSpy.mockRestore();
  });
});
