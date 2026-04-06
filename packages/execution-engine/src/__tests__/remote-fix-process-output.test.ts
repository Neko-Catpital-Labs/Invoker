import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnRemoteAgentFixImpl } from '../conflict-resolver.js';
import type { AgentRegistry } from '../agent-registry.js';

vi.mock('node:child_process');

function mockSpawnChild(stdoutData: string, exitCode: number) {
  const { EventEmitter } = require('events');
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  (child as any).stdout = stdout;
  (child as any).stderr = stderr;
  (child as any).stdin = { write: vi.fn(), end: vi.fn() };

  setTimeout(() => {
    stdout.emit('data', Buffer.from(stdoutData));
    child.emit('close', exitCode);
  }, 0);

  return child;
}

describe('spawnRemoteAgentFixImpl processOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls driver.processOutput with effectiveSessionId and stdout on success', async () => {
    const { spawn } = await import('node:child_process');
    const mockProcessOutput = vi.fn(() => 'display text');
    const mockExtractSessionId = vi.fn(() => 'real-thread-123');
    const mockDriver = {
      processOutput: mockProcessOutput,
      extractSessionId: mockExtractSessionId,
      loadSession: () => null,
      parseSession: () => [],
    };
    const mockRegistry = {
      get: () => ({ name: 'codex', buildFixCommand: () => ({ cmd: 'codex', args: ['exec', 'fix'], sessionId: 'local-uuid' }) }),
      getOrThrow: () => ({ name: 'codex', buildFixCommand: () => ({ cmd: 'codex', args: ['exec', 'fix'], sessionId: 'local-uuid' }) }),
      getSessionDriver: () => mockDriver,
    } as unknown as AgentRegistry;

    vi.mocked(spawn).mockReturnValueOnce(mockSpawnChild('agent output here', 0) as any);

    const result = await spawnRemoteAgentFixImpl(
      'fix the bug',
      '/home/user/worktree',
      { host: '1.2.3.4', user: 'invoker', sshKeyPath: '/tmp/key' },
      'codex',
      mockRegistry,
    );

    expect(mockExtractSessionId).toHaveBeenCalledWith('agent output here');
    expect(mockProcessOutput).toHaveBeenCalledWith('real-thread-123', 'agent output here');
    expect(result.sessionId).toBe('real-thread-123');
  });

  it('calls driver.processOutput even on failure (non-zero exit)', async () => {
    const { spawn } = await import('node:child_process');
    const mockProcessOutput = vi.fn(() => 'display text');
    const mockExtractSessionId = vi.fn(() => 'real-thread-456');
    const mockDriver = {
      processOutput: mockProcessOutput,
      extractSessionId: mockExtractSessionId,
      loadSession: () => null,
      parseSession: () => [],
    };
    const mockRegistry = {
      get: () => ({ name: 'codex', buildFixCommand: () => ({ cmd: 'codex', args: ['exec', 'fix'], sessionId: 'local-uuid' }) }),
      getOrThrow: () => ({ name: 'codex', buildFixCommand: () => ({ cmd: 'codex', args: ['exec', 'fix'], sessionId: 'local-uuid' }) }),
      getSessionDriver: () => mockDriver,
    } as unknown as AgentRegistry;

    vi.mocked(spawn).mockReturnValueOnce(mockSpawnChild('partial output', 1) as any);

    await expect(
      spawnRemoteAgentFixImpl(
        'fix the bug',
        '/home/user/worktree',
        { host: '1.2.3.4', user: 'invoker', sshKeyPath: '/tmp/key' },
        'codex',
        mockRegistry,
      ),
    ).rejects.toThrow('Remote agent fix failed');

    // processOutput should still be called to persist partial session
    expect(mockProcessOutput).toHaveBeenCalledWith('real-thread-456', 'partial output');
  });

  it('uses fallback sessionId when extractSessionId returns undefined', async () => {
    const { spawn } = await import('node:child_process');
    const mockProcessOutput = vi.fn(() => 'display text');
    const mockDriver = {
      processOutput: mockProcessOutput,
      extractSessionId: vi.fn(() => undefined),
      loadSession: () => null,
      parseSession: () => [],
    };
    const mockRegistry = {
      get: () => ({ name: 'claude', buildFixCommand: () => ({ cmd: 'claude', args: ['-p', 'fix'], sessionId: 'local-uuid-abc' }) }),
      getOrThrow: () => ({ name: 'claude', buildFixCommand: () => ({ cmd: 'claude', args: ['-p', 'fix'], sessionId: 'local-uuid-abc' }) }),
      getSessionDriver: () => mockDriver,
    } as unknown as AgentRegistry;

    vi.mocked(spawn).mockReturnValueOnce(mockSpawnChild('output', 0) as any);

    const result = await spawnRemoteAgentFixImpl(
      'fix the bug',
      '/home/user/worktree',
      { host: '1.2.3.4', user: 'invoker', sshKeyPath: '/tmp/key' },
      'claude',
      mockRegistry,
    );

    // Should use the sessionId from buildFixCommand ('local-uuid-abc')
    expect(mockProcessOutput).toHaveBeenCalledWith('local-uuid-abc', 'output');
    expect(result.sessionId).toBe('local-uuid-abc');
  });

  it('skips processOutput when no registry is provided', async () => {
    const { spawn } = await import('node:child_process');

    vi.mocked(spawn).mockReturnValueOnce(mockSpawnChild('output', 0) as any);

    // No registry → no driver → no processOutput call
    const result = await spawnRemoteAgentFixImpl(
      'fix the bug',
      '/home/user/worktree',
      { host: '1.2.3.4', user: 'invoker', sshKeyPath: '/tmp/key' },
    );

    // Should still resolve with a UUID session ID
    expect(result.stdout).toBe('output');
    expect(result.sessionId).toBeDefined();
  });
});
