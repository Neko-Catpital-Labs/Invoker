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

/**
 * Mock child that fires a 'close' event with explicit code and optional stderr,
 * simulating a non-zero exit (e.g. exit 126 for E2BIG, exit 137 for SIGKILL).
 */
function mockSpawnChildExit(exitCode: number, stderrData = '') {
  const { EventEmitter } = require('events');
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  (child as any).stdout = stdout;
  (child as any).stderr = stderr;
  (child as any).stdin = { write: vi.fn(), end: vi.fn() };

  setTimeout(() => {
    if (stderrData) stderr.emit('data', Buffer.from(stderrData));
    child.emit('close', exitCode);
  }, 0);

  return child;
}

/**
 * Mock child that emits an 'error' event before any close, simulating spawn-time
 * failures like E2BIG (argv too long) or ENOENT (binary missing).
 */
function mockSpawnChildErrorEvent(err: Error & { code?: string }) {
  const { EventEmitter } = require('events');
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  (child as any).stdout = stdout;
  (child as any).stderr = stderr;
  (child as any).stdin = { write: vi.fn(), end: vi.fn() };

  setTimeout(() => {
    child.emit('error', err);
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

/**
 * Regression coverage for deleted repros:
 *   - repro-fix-arg-too-long-e2e (scenario 7): E2BIG / argv-too-long surfaces a usable error
 *   - repro-fix-with-claude-exit137 (scenario 9): exit 137 (SIGKILL/OOM) surfaces a usable error
 *
 * These scenarios were proven manually by deleted repro scripts. Production
 * behavior is that spawnAgentFixViaRegistry rejects with an Error whose message
 * carries enough context (exit code or spawn error code + stderr) for operators
 * to recognize argv-size and OOM-kill failures.
 */
describe('spawn errors during agent fix surface diagnostic info', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces E2BIG when spawn emits an error event (argv too long)', async () => {
    const { spawn } = await import('node:child_process');
    const agent = makeExecutionAgent((prompt) => ({
      cmd: 'codex',
      args: ['exec', '--json', prompt],
      sessionId: 'sess-e2big',
    }));

    const e2bigErr = Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' });
    vi.mocked(spawn).mockReturnValueOnce(mockSpawnChildErrorEvent(e2bigErr) as any);

    await expect(spawnAgentFixViaRegistry('small prompt', '/tmp', agent, undefined))
      .rejects.toThrow(/E2BIG/);
  });

  it('surfaces "Argument list too long" via stderr on non-zero exit (code 126)', async () => {
    const { spawn } = await import('node:child_process');
    const agent = makeExecutionAgent((prompt) => ({
      cmd: 'codex',
      args: ['exec', '--json', prompt],
      sessionId: 'sess-126',
    }));

    vi.mocked(spawn).mockReturnValueOnce(
      mockSpawnChildExit(126, 'execve: Argument list too long') as any,
    );

    await expect(spawnAgentFixViaRegistry('small prompt', '/tmp', agent, undefined))
      .rejects.toThrow(/Argument list too long/);
  });

  it('surfaces exit code 137 (SIGKILL/OOM) in the rejection message', async () => {
    const { spawn } = await import('node:child_process');
    const agent = makeExecutionAgent((prompt) => ({
      cmd: 'codex',
      args: ['exec', '--json', prompt],
      sessionId: 'sess-137',
    }));

    vi.mocked(spawn).mockReturnValueOnce(mockSpawnChildExit(137, '') as any);

    await expect(spawnAgentFixViaRegistry('small prompt', '/tmp', agent, undefined))
      .rejects.toThrow(/137/);
  });

  it('includes stderr alongside the 137 exit code when killed with output', async () => {
    const { spawn } = await import('node:child_process');
    const agent = makeExecutionAgent((prompt) => ({
      cmd: 'claude',
      args: ['-p', prompt],
      sessionId: 'sess-137-killed',
    }));

    vi.mocked(spawn).mockReturnValueOnce(mockSpawnChildExit(137, 'Killed') as any);

    let caught: Error | undefined;
    try {
      await spawnAgentFixViaRegistry('small prompt', '/tmp', agent, undefined);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('137');
    expect(caught!.message).toContain('Killed');
  });
});

