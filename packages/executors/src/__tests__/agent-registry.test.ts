import { describe, it, expect } from 'vitest';
import { AgentRegistry } from '../agent-registry.js';
import type { ExecutionAgent, PlanningAgent } from '../agent.js';

function makeExecAgent(name: string, stdinMode: 'ignore' | 'pipe' = 'ignore'): ExecutionAgent {
  return {
    name,
    stdinMode,
    buildCommand: (prompt) => ({ cmd: name, args: ['-p', prompt], sessionId: 'sid-1' }),
    buildResumeArgs: (sid) => ({ cmd: name, args: ['--resume', sid] }),
  };
}

function makePlanAgent(name: string): PlanningAgent {
  return {
    name,
    buildPlanningCommand: (prompt) => ({ command: name, args: ['plan', prompt] }),
  };
}

describe('AgentRegistry', () => {
  it('registers and retrieves an execution agent', () => {
    const reg = new AgentRegistry();
    const agent = makeExecAgent('claude');
    reg.registerExecution(agent);

    expect(reg.get('claude')).toBe(agent);
    expect(reg.get('unknown')).toBeUndefined();
  });

  it('getOrThrow throws for missing agents', () => {
    const reg = new AgentRegistry();
    expect(() => reg.getOrThrow('missing')).toThrow(/No execution agent registered with name "missing"/);
  });

  it('getOrThrow returns agent when registered', () => {
    const reg = new AgentRegistry();
    const agent = makeExecAgent('claude');
    reg.registerExecution(agent);

    expect(reg.getOrThrow('claude')).toBe(agent);
  });

  it('registers and retrieves a planning agent', () => {
    const reg = new AgentRegistry();
    const agent = makePlanAgent('cursor');
    reg.registerPlanning(agent);

    expect(reg.getPlanning('cursor')).toBe(agent);
    expect(reg.getPlanning('unknown')).toBeUndefined();
  });

  it('getPlanningOrThrow throws for missing agents', () => {
    const reg = new AgentRegistry();
    expect(() => reg.getPlanningOrThrow('missing')).toThrow(/No planning agent registered with name "missing"/);
  });

  it('getByCommand looks up execution agents by name', () => {
    const reg = new AgentRegistry();
    const claude = makeExecAgent('claude');
    const other = makeExecAgent('other-agent');
    reg.registerExecution(claude);
    reg.registerExecution(other);

    expect(reg.getByCommand('claude')).toBe(claude);
    expect(reg.getByCommand('other-agent')).toBe(other);
    expect(reg.getByCommand('nonexistent')).toBeUndefined();
  });

  it('lists all registered execution agents', () => {
    const reg = new AgentRegistry();
    reg.registerExecution(makeExecAgent('a'));
    reg.registerExecution(makeExecAgent('b'));

    const list = reg.listExecution();
    expect(list).toHaveLength(2);
    expect(list.map((a) => a.name).sort()).toEqual(['a', 'b']);
  });

  it('lists all registered planning agents', () => {
    const reg = new AgentRegistry();
    reg.registerPlanning(makePlanAgent('x'));
    reg.registerPlanning(makePlanAgent('y'));

    const list = reg.listPlanning();
    expect(list).toHaveLength(2);
    expect(list.map((a) => a.name).sort()).toEqual(['x', 'y']);
  });

  it('overwrites agent on re-registration', () => {
    const reg = new AgentRegistry();
    const first = makeExecAgent('claude');
    const second = makeExecAgent('claude');
    reg.registerExecution(first);
    reg.registerExecution(second);

    expect(reg.get('claude')).toBe(second);
  });
});
