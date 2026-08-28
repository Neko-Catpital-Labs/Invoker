import { describe, it, expect } from 'vitest';
import { ExecutionHarnessSessionDriver, ReplayHarnessSessionDriver } from '../harness-session-driver.js';
import { ClaudeExecutionAgent } from '../agents/claude-execution-agent.js';
import { CodexExecutionAgent } from '../agents/codex-execution-agent.js';
import { OmpExecutionAgent } from '../agents/omp-execution-agent.js';
import { CursorExecutionAgent } from '../agents/cursor-execution-agent.js';
import type { ExecutionAgent, AgentCommandSpec, AgentCommandBuildOptions } from '../agent.js';

describe('ExecutionHarnessSessionDriver', () => {
  describe('claude', () => {
    const driver = new ExecutionHarnessSessionDriver(new ClaudeExecutionAgent());

    it('start returns a sessionId and command shape', () => {
      const result = driver.start('Fix the bug');

      expect(driver.harness).toBe('claude');
      expect(result.command).toBe('claude');
      expect(result.sessionId).toBeTruthy();
      expect(result.args).toContain('--session-id');
      expect(result.args).toContain(result.sessionId);
      expect(result.args).toContain('-p');
      expect(result.args).toContain('Fix the bug');
    });

    it('append resumes the session and appends the prompt', () => {
      const result = driver.append('session-abc', 'Now add a test', { model: 'sonnet' });

      expect(result.command).toBe('claude');
      expect(result.sessionId).toBe('session-abc');
      expect(result.args).toEqual([
        '--resume',
        'session-abc',
        '--dangerously-skip-permissions',
        '--model',
        'sonnet',
        '-p',
        'Now add a test',
      ]);
    });

    it('append omits model args when no model is given', () => {
      const result = driver.append('session-abc', 'Now add a test');

      expect(result.args).toEqual([
        '--resume',
        'session-abc',
        '--dangerously-skip-permissions',
        '-p',
        'Now add a test',
      ]);
    });

    it('start prepends --mcp-config before all other args when mcpConfigPath is set', () => {
      const mcpDriver = new ExecutionHarnessSessionDriver(new ClaudeExecutionAgent(), undefined, '/tmp/planning/.mcp.json');
      const result = mcpDriver.start('Fix the bug');

      expect(result.args).toEqual([
        '--mcp-config',
        '/tmp/planning/.mcp.json',
        '--session-id',
        result.sessionId,
        '--dangerously-skip-permissions',
        '-p',
        'Fix the bug',
      ]);
    });

    it('append prepends --mcp-config before all other args when mcpConfigPath is set', () => {
      const mcpDriver = new ExecutionHarnessSessionDriver(new ClaudeExecutionAgent(), undefined, '/tmp/planning/.mcp.json');
      const result = mcpDriver.append('session-abc', 'Now add a test', { model: 'sonnet' });

      expect(result.args).toEqual([
        '--mcp-config',
        '/tmp/planning/.mcp.json',
        '--resume',
        'session-abc',
        '--dangerously-skip-permissions',
        '--model',
        'sonnet',
        '-p',
        'Now add a test',
      ]);
    });
  });

  describe('codex', () => {
    const driver = new ExecutionHarnessSessionDriver(new CodexExecutionAgent());

    it('append shapes argv as exec resume with the prompt trailing', () => {
      const result = driver.append('session-xyz', 'Continue the task', { model: 'gpt-5.5' });

      expect(driver.harness).toBe('codex');
      expect(result.command).toBe('codex');
      expect(result.sessionId).toBe('session-xyz');
      expect(result.args).toEqual([
        'exec',
        'resume',
        '--dangerously-bypass-approvals-and-sandbox',
        'session-xyz',
        '--model',
        'gpt-5.5',
        'Continue the task',
      ]);
    });

    it('promotes the real Codex thread id from stdout for new sessions', () => {
      const driver = new ExecutionHarnessSessionDriver(new CodexExecutionAgent(), {
        extractSessionId: () => 'real-codex-thread-id',
      });

      expect(driver.resolveSessionId?.('', {
        command: 'codex',
        args: [],
        sessionId: 'local-invoker-uuid',
      }, { startedNewSession: true })).toBe('real-codex-thread-id');
    });

    it('rejects a new Codex session when stdout has no resumable thread id', () => {
      const driver = new ExecutionHarnessSessionDriver(new CodexExecutionAgent(), {
        extractSessionId: () => undefined,
      });

      expect(() => driver.resolveSessionId?.('', {
        command: 'codex',
        args: [],
        sessionId: 'local-invoker-uuid',
      }, { startedNewSession: true })).toThrow(/thread\.started\.thread_id/);
    });

    it('rejects a new Codex session when no session extractor is registered', () => {
      const driver = new ExecutionHarnessSessionDriver(new CodexExecutionAgent());

      expect(() => driver.resolveSessionId?.('', {
        command: 'codex',
        args: [],
        sessionId: 'local-invoker-uuid',
      }, { startedNewSession: true })).toThrow(/thread\.started\.thread_id/);
    });

    it('append appends -c mcp_servers.invoker overrides after all other args when mcpConfigPath is set', () => {
      const mcpDriver = new ExecutionHarnessSessionDriver(new CodexExecutionAgent(), undefined, '/tmp/planning/.mcp.json');
      const result = mcpDriver.append('session-xyz', 'Continue the task', { model: 'gpt-5.5' });

      expect(result.args).toEqual([
        'exec',
        'resume',
        '--dangerously-bypass-approvals-and-sandbox',
        'session-xyz',
        '--model',
        'gpt-5.5',
        'Continue the task',
        '-c',
        'mcp_servers.invoker.command="invoker-cli"',
        '-c',
        'mcp_servers.invoker.args=["mcp"]',
      ]);
    });

    it('start appends -c mcp_servers.invoker overrides after all other args when mcpConfigPath is set', () => {
      const mcpDriver = new ExecutionHarnessSessionDriver(new CodexExecutionAgent(), undefined, '/tmp/planning/.mcp.json');
      const result = mcpDriver.start('Fix the bug');

      expect(result.args).toEqual([
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        'Fix the bug',
        '-c',
        'mcp_servers.invoker.command="invoker-cli"',
        '-c',
        'mcp_servers.invoker.args=["mcp"]',
      ]);
    });
  });

  describe('omp', () => {
    const driver = new ExecutionHarnessSessionDriver(new OmpExecutionAgent({ sessionDirRoot: '/tmp/omp-test-sessions' }));

    it('append resumes the session directory and appends the prompt', () => {
      const result = driver.append('session-123', 'Ship it', { model: 'chatgpt-5.4' });

      expect(driver.harness).toBe('omp');
      expect(result.command).toBe('omp');
      expect(result.sessionId).toBe('session-123');
      expect(result.args).toEqual([
        '--session-dir',
        '/tmp/omp-test-sessions/session-123',
        '--continue',
        '--model',
        'chatgpt-5.4',
        '-p',
        'Ship it',
      ]);
    });

    it('leaves argv unchanged for a non-claude/codex harness even when mcpConfigPath is set', () => {
      const mcpDriver = new ExecutionHarnessSessionDriver(
        new OmpExecutionAgent({ sessionDirRoot: '/tmp/omp-test-sessions' }),
        undefined,
        '/tmp/planning/.mcp.json',
      );
      const result = mcpDriver.append('session-123', 'Ship it', { model: 'chatgpt-5.4' });

      expect(result.args).toEqual([
        '--session-dir',
        '/tmp/omp-test-sessions/session-123',
        '--continue',
        '--model',
        'chatgpt-5.4',
        '-p',
        'Ship it',
      ]);
    });
  });

  describe('cursor', () => {
    const driver = new ExecutionHarnessSessionDriver(new CursorExecutionAgent({ command: 'cursor-test' }));

    it('append resumes with print/trust and the trailing prompt', () => {
      const result = driver.append('session-cursor', 'Now add a test', { model: 'grok-4.5' });

      expect(driver.harness).toBe('cursor');
      expect(result.command).toBe('cursor-test');
      expect(result.sessionId).toBe('session-cursor');
      expect(result.args).toEqual([
        'agent',
        '--resume',
        'session-cursor',
        '--print',
        '--trust',
        '--model',
        'grok-4.5',
        'Now add a test',
      ]);
    });

    it('append omits model args when no model is given', () => {
      const result = driver.append('session-cursor', 'Now add a test');

      expect(result.args).toEqual([
        'agent',
        '--resume',
        'session-cursor',
        '--print',
        '--trust',
        'Now add a test',
      ]);
    });
  });

  describe('unsupported harness', () => {
    class FakeExecutionAgent implements ExecutionAgent {
      readonly name = 'fake';
      readonly stdinMode = 'ignore' as const;

      buildCommand(fullPrompt: string, _options?: AgentCommandBuildOptions): AgentCommandSpec {
        return { cmd: 'fake', args: [fullPrompt], sessionId: 'fake-session' };
      }

      buildResumeArgs(sessionId: string): { cmd: string; args: string[] } {
        return { cmd: 'fake', args: ['--resume', sessionId] };
      }
    }

    it('throws on append for a harness without append support', () => {
      const driver = new ExecutionHarnessSessionDriver(new FakeExecutionAgent());

      expect(() => driver.append('session-1', 'Do the thing')).toThrow(/does not support/);
    });

    it('throws on start when buildCommand does not return a sessionId', () => {
      class NoSessionExecutionAgent extends FakeExecutionAgent {
        buildCommand(fullPrompt: string): AgentCommandSpec {
          return { cmd: 'fake', args: [fullPrompt] };
        }
      }

      const driver = new ExecutionHarnessSessionDriver(new NoSessionExecutionAgent());

      expect(() => driver.start('Do the thing')).toThrow(/did not return a session id/);
    });
  });
});

describe('ReplayHarnessSessionDriver', () => {
  const buildCommand = (prompt: string, options?: { model?: string }) => ({
    command: 'cursor-agent',
    args: [...(options?.model ? ['--model', options.model] : []), '-p', prompt],
  });

  it('start produces a command and a fresh sessionId', () => {
    const driver = new ReplayHarnessSessionDriver('cursor', buildCommand);
    const result = driver.start('Fix the bug', { model: 'gpt-5.6' });

    expect(driver.harness).toBe('cursor');
    expect(result.command).toBe('cursor-agent');
    expect(result.args).toEqual(['--model', 'gpt-5.6', '-p', 'Fix the bug']);
    expect(result.sessionId).toBeTruthy();
  });

  it('append produces a command and mints a new sessionId rather than resuming', () => {
    const driver = new ReplayHarnessSessionDriver('cursor', buildCommand);
    const started = driver.start('Fix the bug');
    const appended = driver.append(started.sessionId, 'Now add a test');

    expect(appended.command).toBe('cursor-agent');
    expect(appended.args).toEqual(['-p', 'Now add a test']);
    expect(appended.sessionId).toBeTruthy();
    expect(appended.sessionId).not.toBe(started.sessionId);
  });
});
