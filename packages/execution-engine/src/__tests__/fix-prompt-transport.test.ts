import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnAgentFixViaRegistry, spawnRemoteAgentFixImpl } from '../conflict-resolver.js';
import type { ExecutionAgent } from '../agent.js';
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

function makeExecutionAgent(buildFixCommand: (prompt: string) => { cmd: string; args: string[]; sessionId?: string }): ExecutionAgent {
  return {
    name: 'codex',
    stdinMode: 'ignore',
    linuxTerminalTail: 'exec_bash',
    buildCommand: (fullPrompt: string) => ({ cmd: 'codex', args: ['exec', '--json', fullPrompt] }),
    buildResumeArgs: (sessionId: string) => ({ cmd: 'codex', args: ['resume', sessionId] }),
    buildFixCommand,
  };
}

describe('fix prompt transport for oversized prompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('local fix path replaces oversized prompt arg with file-backed bootstrap prompt', async () => {
    const { spawn } = await import('node:child_process');
    const captured: { prompt?: string } = {};
    const agent = makeExecutionAgent((prompt) => {
      captured.prompt = prompt;
      return { cmd: 'codex', args: ['exec', '--json', prompt], sessionId: 'local-sess' };
    });

    vi.mocked(spawn).mockReturnValueOnce(mockSpawnChild('ok', 0) as any);

    const hugePrompt = 'A'.repeat(400_000);
    const result = await spawnAgentFixViaRegistry(hugePrompt, '/tmp', agent, undefined);
    expect(result.sessionId).toBe('local-sess');
    expect(captured.prompt).toBeDefined();
    expect(captured.prompt).toContain('The full task instructions are in this file:');
    expect(captured.prompt).toContain('/tmp/invoker-agent-prompt-');
    expect(captured.prompt).not.toContain(hugePrompt.slice(0, 200));
  });

  it('remote fix path writes oversized prompt to remote temp file and passes short bootstrap prompt', async () => {
    const { spawn } = await import('node:child_process');
    const buildFixCommand = vi.fn((prompt: string) => ({
      cmd: 'codex',
      args: ['exec', '--json', prompt],
      sessionId: 'remote-sess',
    }));

    const child = mockSpawnChild('remote ok', 0) as any;
    let stdinScript = '';
    child.stdin.write = vi.fn((chunk: string) => {
      stdinScript += chunk;
      return true;
    });
    vi.mocked(spawn).mockReturnValueOnce(child);

    const registry = {
      get: () => ({ name: 'codex', buildFixCommand }),
      getOrThrow: () => ({ name: 'codex', buildFixCommand }),
      getSessionDriver: () => undefined,
    } as unknown as AgentRegistry;

    const hugePrompt = 'B'.repeat(400_000);
    await spawnRemoteAgentFixImpl(
      hugePrompt,
      '/home/user/worktree',
      { host: '1.2.3.4', user: 'invoker', sshKeyPath: '/tmp/key' },
      'codex',
      registry,
    );

    expect(buildFixCommand).toHaveBeenCalledTimes(1);
    const bootstrapPrompt = buildFixCommand.mock.calls[0][0];
    expect(bootstrapPrompt).toContain('The full task instructions are in this file:');
    expect(bootstrapPrompt).toContain('/tmp/invoker-agent-prompt-');
    expect(stdinScript).toContain('PROMPT_FILE=');
    expect(stdinScript).toContain('base64 -d > "$PROMPT_FILE"');
    expect(stdinScript).toContain("trap 'rm -f \"$PROMPT_FILE\"' EXIT");
  });
});

