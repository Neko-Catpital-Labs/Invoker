import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ClaudeExecutionAgent } from '../agents/claude-execution-agent.js';

describe('ClaudeExecutionAgent', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('buildCommand', () => {
    it('returns claude command with session ID and prompt', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildCommand('Fix the bug');

      expect(spec.cmd).toBe('claude');
      expect(spec.args).toContain('--session-id');
      expect(spec.args).toContain('--dangerously-skip-permissions');
      expect(spec.args).toContain('-p');
      expect(spec.args).toContain('Fix the bug');
      expect(spec.sessionId).toBeDefined();
      expect(spec.fullPrompt).toBe('Fix the bug');
    });

    it('generates unique session IDs per call', () => {
      const agent = new ClaudeExecutionAgent();
      const spec1 = agent.buildCommand('prompt 1');
      const spec2 = agent.buildCommand('prompt 2');

      expect(spec1.sessionId).not.toBe(spec2.sessionId);
    });

    it('uses custom command from config', () => {
      const agent = new ClaudeExecutionAgent({ command: '/usr/local/bin/claude' });
      const spec = agent.buildCommand('test');

      expect(spec.cmd).toBe('/usr/local/bin/claude');
    });

    it('places args in correct order: --session-id, id, --dangerously-skip-permissions, -p, prompt', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildCommand('my prompt');

      expect(spec.args[0]).toBe('--session-id');
      expect(spec.args[1]).toBe(spec.sessionId);
      expect(spec.args[2]).toBe('--dangerously-skip-permissions');
      expect(spec.args[3]).toBe('-p');
      expect(spec.args[4]).toBe('my prompt');
    });
  });

  describe('buildFixCommand', () => {
    it('returns claude command with session ID, prompt, and dangerously-skip-permissions', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildFixCommand('Fix the bug');

      expect(spec.cmd).toBe('claude');
      expect(spec.args).toContain('--session-id');
      expect(spec.args).toContain('-p');
      expect(spec.args).toContain('Fix the bug');
      expect(spec.args).toContain('--dangerously-skip-permissions');
      expect(spec.sessionId).toBeDefined();
    });

    it('generates unique session IDs per call', () => {
      const agent = new ClaudeExecutionAgent();
      const spec1 = agent.buildFixCommand('prompt 1');
      const spec2 = agent.buildFixCommand('prompt 2');

      expect(spec1.sessionId).not.toBe(spec2.sessionId);
    });

    it('uses custom command from config', () => {
      const agent = new ClaudeExecutionAgent({ command: '/usr/local/bin/claude' });
      const spec = agent.buildFixCommand('test');

      expect(spec.cmd).toBe('/usr/local/bin/claude');
    });

    it('places --session-id and its value at the start of args', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildFixCommand('my prompt');

      expect(spec.args[0]).toBe('--session-id');
      expect(spec.args[1]).toBe(spec.sessionId);
    });

    it('stored sessionId matches the CLI --session-id value', () => {
      const agent = new ClaudeExecutionAgent();
      const spec = agent.buildFixCommand('my prompt');

      const idx = spec.args.indexOf('--session-id');
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(spec.args[idx + 1]).toBe(spec.sessionId);
    });
  });

  describe('buildResumeArgs', () => {
    it('returns claude resume command with session ID', () => {
      const agent = new ClaudeExecutionAgent();
      const result = agent.buildResumeArgs('test-session-id');

      expect(result.cmd).toBe('claude');
      expect(result.args).toEqual(['--resume', 'test-session-id', '--dangerously-skip-permissions']);
    });

    it('uses custom command from config', () => {
      const agent = new ClaudeExecutionAgent({ command: 'claude-dev' });
      const result = agent.buildResumeArgs('sid');

      expect(result.cmd).toBe('claude-dev');
    });
  });

  describe('getContainerRequirements', () => {
    it('returns mounts for .claude config dir', () => {
      const agent = new ClaudeExecutionAgent({ configDir: '/test/.claude' });
      const reqs = agent.getContainerRequirements();

      expect(reqs.mounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ hostPath: '/test/.claude', containerPath: '/home/invoker/.claude' }),
        ]),
      );
    });

    it('returns ANTHROPIC_API_KEY in env', () => {
      const agent = new ClaudeExecutionAgent({ apiKey: 'sk-test-key' });
      const reqs = agent.getContainerRequirements();

      expect(reqs.env.ANTHROPIC_API_KEY).toBe('sk-test-key');
    });

    it('uses custom containerHomePath for mount targets', () => {
      const agent = new ClaudeExecutionAgent({ configDir: '/test/.claude', containerHomePath: '/root' });
      const reqs = agent.getContainerRequirements();

      expect(reqs.mounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ containerPath: '/root/.claude' }),
        ]),
      );
    });

    it('falls back to process.env.ANTHROPIC_API_KEY', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-from-env';
      const agent = new ClaudeExecutionAgent();
      const reqs = agent.getContainerRequirements();

      expect(reqs.env.ANTHROPIC_API_KEY).toBe('sk-from-env');
    });
  });

  describe('properties', () => {
    it('has name = "claude"', () => {
      const agent = new ClaudeExecutionAgent();
      expect(agent.name).toBe('claude');
    });

    it('has stdinMode = "ignore"', () => {
      const agent = new ClaudeExecutionAgent();
      expect(agent.stdinMode).toBe('ignore');
    });
  });
});
