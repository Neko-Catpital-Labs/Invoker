import { describe, it, expect } from 'vitest';
import { assertPlanExecutionAgentsRegistered } from '../plan-execution-agents.js';
import { AgentRegistry } from '../agent-registry.js';
import { ClaudeExecutionAgent } from '../agents/claude-execution-agent.js';
import { CodexExecutionAgent } from '../agents/codex-execution-agent.js';

function makeRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.registerExecution(new ClaudeExecutionAgent());
  registry.registerExecution(new CodexExecutionAgent());
  return registry;
}

describe('assertPlanExecutionAgentsRegistered', () => {
  it('passes when all executionAgent names are registered', () => {
    const plan = {
      tasks: [
        { id: 'a', executionAgent: 'claude' },
        { id: 'b', executionAgent: 'codex' },
        { id: 'c' }, // no executionAgent — should be ignored
      ],
    };
    expect(() => assertPlanExecutionAgentsRegistered(plan, makeRegistry())).not.toThrow();
  });

  it('passes when no tasks specify executionAgent', () => {
    const plan = {
      tasks: [{ id: 'a' }, { id: 'b' }],
    };
    expect(() => assertPlanExecutionAgentsRegistered(plan, makeRegistry())).not.toThrow();
  });

  it('throws when a task references an unknown agent', () => {
    const plan = {
      tasks: [
        { id: 'a', executionAgent: 'claude' },
        { id: 'b', executionAgent: 'unknown-agent' },
      ],
    };
    expect(() => assertPlanExecutionAgentsRegistered(plan, makeRegistry())).toThrow(
      /unknown executionAgent "unknown-agent"/,
    );
  });

  it('error message lists available agents', () => {
    const plan = {
      tasks: [{ id: 'x', executionAgent: 'does-not-exist' }],
    };
    expect(() => assertPlanExecutionAgentsRegistered(plan, makeRegistry())).toThrow(
      /Available agents:.*claude.*codex/,
    );
  });

  it('reports all invalid tasks in one error', () => {
    const plan = {
      tasks: [
        { id: 'a', executionAgent: 'bad1' },
        { id: 'b', executionAgent: 'bad2' },
      ],
    };
    try {
      assertPlanExecutionAgentsRegistered(plan, makeRegistry());
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('Task "a" references unknown executionAgent "bad1"');
      expect(msg).toContain('Task "b" references unknown executionAgent "bad2"');
    }
  });

  it('trims whitespace from executionAgent before lookup', () => {
    const plan = {
      tasks: [{ id: 'a', executionAgent: '  claude  ' }],
    };
    expect(() => assertPlanExecutionAgentsRegistered(plan, makeRegistry())).not.toThrow();
  });
});
