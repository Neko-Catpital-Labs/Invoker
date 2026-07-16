import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnAgentFixViaRegistry, spawnRemoteAgentFixImpl } from '../conflict-resolver.js';
import type { AgentCommandBuildOptions, ExecutionAgent } from '../agent.js';
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

async function resetSpawnMock() {
  const { spawn } = await import('node:child_process');
  vi.mocked(spawn).mockReset();
}

function makeExecutionAgent(buildFixCommand: ExecutionAgent['buildFixCommand']): ExecutionAgent {
  return {
    name: 'codex',
    stdinMode: 'ignore',
    linuxTerminalTail: 'exec_bash',
    supportsModel: () => true,
    buildCommand: (fullPrompt: string) => ({ cmd: 'codex', args: ['exec', '--json', fullPrompt] }),
    buildResumeArgs: (sessionId: string) => ({ cmd: 'codex', args: ['resume', sessionId] }),
    buildFixCommand,
  };
}

describe('fix prompt transport for oversized prompts', () => {
  beforeEach(async () => {
    await resetSpawnMock();
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
    expect(captured.prompt).toContain('invoker-agent-prompt-');
    expect(captured.prompt).not.toContain(hugePrompt.slice(0, 200));
  });
  it('passes executionModel to local fix command builders', async () => {
    const { spawn } = await import('node:child_process');
    const buildFixCommand = vi.fn((prompt: string, options?: { executionModel?: string }) => ({
      cmd: 'codex',
      args: ['exec', '--json', ...(options?.executionModel ? ['--model', options.executionModel] : []), prompt],
      sessionId: 'local-model-sess',
    }));
    const agent = makeExecutionAgent(buildFixCommand);

    vi.mocked(spawn).mockReturnValueOnce(mockSpawnChild('ok', 0) as any);

    const result = await spawnAgentFixViaRegistry('small prompt', '/tmp', agent, undefined, 'gpt-5.1-codex-max');
    expect(result.sessionId).toBe('local-model-sess');
    expect(buildFixCommand).toHaveBeenCalledWith('small prompt', { executionModel: 'gpt-5.1-codex-max' });
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

  it('passes resolved executionModel into local OMP fix commands', async () => {
    const { spawn } = await import('node:child_process');
    const buildFixCommand = vi.fn((prompt: string, options?: AgentCommandBuildOptions) => ({
      cmd: 'omp',
      args: ['--model', options?.executionModel ?? 'missing', '-p', prompt],
      sessionId: 'omp-local-sess',
    }));
    const agent: ExecutionAgent = {
      name: 'omp',
      stdinMode: 'ignore',
      linuxTerminalTail: 'exec_bash',
      supportsModel: () => true,
      buildCommand: (fullPrompt: string) => ({ cmd: 'omp', args: ['-p', fullPrompt] }),
      buildResumeArgs: (sessionId: string) => ({ cmd: 'omp', args: ['resume', sessionId] }),
      buildFixCommand,
    };

    vi.mocked(spawn).mockReturnValueOnce(mockSpawnChild('ok', 0) as any);

    await spawnAgentFixViaRegistry(
      'small prompt',
      '/tmp',
      agent,
      undefined,
      'anthropic/claude-opus-4',
    );

    expect(buildFixCommand).toHaveBeenCalledWith(
      'small prompt',
      { executionModel: 'anthropic/claude-opus-4' },
    );
  });

  it('passes resolved executionModel into remote OMP fix commands', async () => {
    const { spawn } = await import('node:child_process');
    const buildFixCommand = vi.fn((prompt: string, options?: AgentCommandBuildOptions) => ({
      cmd: 'omp',
      args: ['--model', options?.executionModel ?? 'missing', '-p', prompt],
      sessionId: 'omp-remote-sess',
    }));

    const child = mockSpawnChild('remote ok', 0) as any;
    let stdinScript = '';
    child.stdin.write = vi.fn((chunk: string) => {
      stdinScript += chunk;
      return true;
    });
    vi.mocked(spawn).mockReturnValueOnce(child);

    const registry = {
      get: () => ({ name: 'omp', buildFixCommand }),
      getOrThrow: () => ({ name: 'omp', buildFixCommand }),
      getSessionDriver: () => undefined,
    } as unknown as AgentRegistry;

    await spawnRemoteAgentFixImpl(
      'small prompt',
      '/home/user/worktree',
      { host: '1.2.3.4', user: 'invoker', sshKeyPath: '/tmp/key' },
      'omp',
      registry,
      'anthropic/claude-opus-4',
    );

    expect(buildFixCommand).toHaveBeenCalledWith(
      'small prompt',
      { executionModel: 'anthropic/claude-opus-4' },
    );
    expect(stdinScript).toContain('eval "$(echo "');
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
  beforeEach(async () => {
    await resetSpawnMock();
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

  it('surfaces the codex --json stdout error, not the benign stdin noise, on non-zero exit', async () => {
    const { spawn } = await import('node:child_process');
    const agent = makeExecutionAgent((prompt) => ({
      cmd: 'codex',
      args: ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', prompt],
      sessionId: 'sess-codex-fail',
    }));
    const driver = {
      processOutput: () => '[assistant] Model refused: usage limit reached',
      extractSessionId: () => undefined,
      loadSession: () => null,
      parseSession: () => [],
      inspectSession: () => ({ state: 'error' as const }),
    };

    const { EventEmitter } = require('events');
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    (child as any).stdout = stdout;
    (child as any).stderr = stderr;
    (child as any).stdin = { write: vi.fn(), end: vi.fn() };
    setTimeout(() => {
      stdout.emit('data', Buffer.from('{"type":"error","message":"usage limit reached"}\n'));
      stderr.emit('data', Buffer.from('Reading additional input from stdin...\n'));
      child.emit('close', 1);
    }, 0);
    vi.mocked(spawn).mockReturnValueOnce(child as any);

    let caught: Error | undefined;
    try {
      await spawnAgentFixViaRegistry('small prompt', '/tmp', agent, driver as any);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('codex fix exited with code 1');
    expect(caught!.message).toContain('Model refused: usage limit reached');
    expect(caught!.message).not.toContain('Reading additional input from stdin');
  });

  it('gives an actionable hint when codex exits non-zero emitting only the stdin/TTY noise', async () => {
    const { spawn } = await import('node:child_process');
    const agent = makeExecutionAgent((prompt) => ({
      cmd: 'codex',
      args: ['exec', '--json', prompt],
      sessionId: 'sess-codex-notty',
    }));

    vi.mocked(spawn).mockReturnValueOnce(
      mockSpawnChildExit(1, 'Reading additional input from stdin...\n') as any,
    );

    let caught: Error | undefined;
    try {
      await spawnAgentFixViaRegistry('small prompt', '/tmp', agent, undefined);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('without a controlling TTY');
    expect(caught!.message).toContain('openai/codex#19945');
  });
});
