import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from '../agent-registry.js';
import type { ExecutionAgent } from '../agent.js';

function makeExecutionAgent(name: string): ExecutionAgent {
  return {
    name,
    buildCommand: () => ({ cmd: name, args: [] }),
    buildResumeArgs: (sessionId: string) => ['resume', sessionId],
    buildFixCommand: (prompt: string) => ({ cmd: name, args: ['fix', prompt] }),
    parseSessionId: () => undefined,
    stdinMode: 'pipe',
  };
}

describe('AgentRegistry', () => {
  let registry: AgentRegistry;
  let claude: ExecutionAgent;
  let codex: ExecutionAgent;

  beforeEach(() => {
    registry = new AgentRegistry();
    claude = makeExecutionAgent('claude');
    codex = makeExecutionAgent('codex');
    registry.registerExecution(claude);
    registry.registerExecution(codex);
  });

  it('defaults nullish execution agent names to claude', () => {
    expect(registry.getOrThrow(undefined)).toBe(claude);
    expect(registry.getOrThrow(null)).toBe(claude);
    expect(registry.getOrThrow('')).toBe(claude);
    expect(registry.getOrThrow('   ')).toBe(claude);
    expect(registry.getOrThrow('null')).toBe(claude);
    expect(registry.getOrThrow('undefined')).toBe(claude);
  });

  it('keeps explicit valid execution agent names working', () => {
    expect(registry.getOrThrow('codex')).toBe(codex);
    expect(registry.getOrThrow(' codex ')).toBe(codex);
  });

  it('still throws for real unknown execution agent names', () => {
    expect(() => registry.getOrThrow('cluade')).toThrow(
      'No execution agent registered with name "cluade". Available: [claude, codex]',
    );
  });
});
