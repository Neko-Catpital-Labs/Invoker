import { describe, it, expect } from 'vitest';
import { ExecutionHarnessSessionDriver, ReplayHarnessSessionDriver } from '@invoker/execution-engine';
import type { ExecutionAgent } from '@invoker/execution-engine';
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
});
