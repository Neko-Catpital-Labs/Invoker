import { describe, it, expect } from 'vitest';
import { ExecutionHarnessSessionDriver, ReplayHarnessSessionDriver } from '@invoker/execution-engine';
import type { ExecutionAgent, SessionDriver } from '@invoker/execution-engine';
import { selectHarnessSessionDriver } from '../slack/harness-session-driver-select.js';

function fakeExecutionAgent(name: string): ExecutionAgent {
  return {
    name,
    stdinMode: 'ignore',
    buildCommand: (fullPrompt) => ({ cmd: name, args: [fullPrompt], sessionId: 'session-1' }),
    buildResumeArgs: (sessionId) => ({ cmd: name, args: ['--resume', sessionId] }),
  };
}

describe('selectHarnessSessionDriver', () => {
  it('returns an ExecutionHarnessSessionDriver when an execution agent is registered for the preset tool', () => {
    const claude = fakeExecutionAgent('claude');
    const driver = selectHarnessSessionDriver(
      { tool: 'claude', model: 'sonnet' },
      { executionAgentRegistry: { get: (name) => (name === 'claude' ? claude : undefined) } },
    );

    expect(driver).toBeInstanceOf(ExecutionHarnessSessionDriver);
    expect(driver?.supportsSessionContinuity).toBe(true);
    expect(driver?.harness).toBe('claude');
  });

  it('passes the registered session driver into execution-backed planning drivers', () => {
    const codex = fakeExecutionAgent('codex');
    const sessionDriver: SessionDriver = {
      processOutput: () => '',
      loadSession: () => null,
      parseSession: () => [],
      inspectSession: () => ({ state: 'finished' }),
      extractSessionId: () => 'real-codex-thread-id',
    };
    const driver = selectHarnessSessionDriver(
      { tool: 'codex' },
      {
        executionAgentRegistry: {
          get: (name) => (name === 'codex' ? codex : undefined),
          getSessionDriver: (name) => (name === 'codex' ? sessionDriver : undefined),
        },
      },
    );

    const started = driver?.start('Plan the change');
    expect(driver?.resolveSessionId?.('', started!, { startedNewSession: true })).toBe('real-codex-thread-id');
  });

  it('falls back to a ReplayHarnessSessionDriver when no execution agent matches the preset tool', () => {
    const driver = selectHarnessSessionDriver(
      { tool: 'cursor' },
      {
        executionAgentRegistry: { get: () => undefined },
        planningCommandBuilder: (opts) => ({ command: 'cursor-agent', args: ['-p', opts.prompt] }),
      },
    );

    expect(driver).toBeInstanceOf(ReplayHarnessSessionDriver);
    expect(driver?.supportsSessionContinuity).toBe(false);
    expect(driver?.harness).toBe('cursor');
  });

  it('returns undefined when neither an execution agent nor a planning command builder is available', () => {
    const driver = selectHarnessSessionDriver({ tool: 'cursor' }, { executionAgentRegistry: { get: () => undefined } });

    expect(driver).toBeUndefined();
  });

  it('returns undefined when no dependencies are provided at all', () => {
    const driver = selectHarnessSessionDriver({ tool: 'cursor' }, {});

    expect(driver).toBeUndefined();
  });

  it('omits --mcp-config when mcpConfigPath is not in deps, matching pre-MCP behavior byte-for-byte', () => {
    const claude = fakeExecutionAgent('claude');
    const driver = selectHarnessSessionDriver(
      { tool: 'claude', model: 'sonnet' },
      { executionAgentRegistry: { get: (name) => (name === 'claude' ? claude : undefined) } },
    );

    const result = driver?.start('Fix the bug');
    expect(result?.args).toEqual(['Fix the bug']);
  });

  it('threads mcpConfigPath through to the ExecutionHarnessSessionDriver argv', () => {
    const claude = fakeExecutionAgent('claude');
    const driver = selectHarnessSessionDriver(
      { tool: 'claude', model: 'sonnet' },
      {
        executionAgentRegistry: { get: (name) => (name === 'claude' ? claude : undefined) },
        mcpConfigPath: '/tmp/planning/.mcp.json',
      },
    );

    const result = driver?.start('Fix the bug');
    expect(result?.args).toEqual(['--mcp-config', '/tmp/planning/.mcp.json', 'Fix the bug']);
  });
});
