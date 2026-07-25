import { describe, it, expect } from 'vitest';
import { ExecutionHarnessSessionDriver, ReplayHarnessSessionDriver } from '../harness-session-driver.js';
import { ClaudeExecutionAgent } from '../agents/claude-execution-agent.js';
import { CodexExecutionAgent } from '../agents/codex-execution-agent.js';
import { OmpExecutionAgent } from '../agents/omp-execution-agent.js';
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
