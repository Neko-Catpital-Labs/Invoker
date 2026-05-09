import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from '../agent-registry.js';
import type { ExecutionAgent } from '../agent.js';

function makeExecutionAgent(name: string, opts?: {
  bundledSkillRoot?: string;
  bundledSkills?: readonly string[];
}): ExecutionAgent {
  return {
    name,
    buildCommand: () => ({ cmd: name, args: [] }),
    buildResumeArgs: (sessionId: string) => ({ cmd: name, args: ['resume', sessionId] }),
    buildFixCommand: (prompt: string) => ({ cmd: name, args: ['fix', prompt] }),
    stdinMode: 'pipe',
    ...(opts?.bundledSkillRoot !== undefined && { bundledSkillRoot: opts.bundledSkillRoot }),
    ...(opts?.bundledSkills !== undefined && { bundledSkills: opts.bundledSkills }),
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

  describe('capability lookup', () => {
    let prClaude: ExecutionAgent;
    let prCodex: ExecutionAgent;
    let noCapsAgent: ExecutionAgent;
    let capRegistry: AgentRegistry;

    beforeEach(() => {
      capRegistry = new AgentRegistry();
      prClaude = makeExecutionAgent('claude', {
        bundledSkillRoot: '/home/user/.claude/skills',
        bundledSkills: ['make-pr'],
      });
      prCodex = makeExecutionAgent('codex', {
        bundledSkillRoot: '/home/user/.codex/skills',
        bundledSkills: ['make-pr'],
      });
      noCapsAgent = makeExecutionAgent('bare-agent');
      capRegistry.registerExecution(prClaude);
      capRegistry.registerExecution(prCodex);
      capRegistry.registerExecution(noCapsAgent);
    });

    it('getWithCapability returns the first agent registered with the skill', () => {
      const agent = capRegistry.getWithCapability('make-pr');
      expect(agent).toBe(prClaude);
    });

    it('getWithCapability is deterministic across repeated calls', () => {
      const first = capRegistry.getWithCapability('make-pr');
      const second = capRegistry.getWithCapability('make-pr');
      expect(first).toBe(second);
    });

    it('getWithCapability returns undefined for unknown skills', () => {
      expect(capRegistry.getWithCapability('deploy')).toBeUndefined();
    });

    it('getWithCapability skips agents without bundledSkills', () => {
      // Register only an agent without capabilities
      const minimal = new AgentRegistry();
      minimal.registerExecution(noCapsAgent);
      expect(minimal.getWithCapability('make-pr')).toBeUndefined();
    });

    it('listWithCapability returns all agents that bundle the skill', () => {
      const agents = capRegistry.listWithCapability('make-pr');
      expect(agents).toHaveLength(2);
      expect(agents[0]).toBe(prClaude);
      expect(agents[1]).toBe(prCodex);
    });

    it('listWithCapability returns empty array for unknown skills', () => {
      expect(capRegistry.listWithCapability('deploy')).toEqual([]);
    });

    it('listWithCapability excludes agents without bundledSkills', () => {
      const agents = capRegistry.listWithCapability('make-pr');
      expect(agents).not.toContain(noCapsAgent);
    });

    it('bundledSkillRoot resolves only for PR-capable agents', () => {
      // PR-capable agents expose their skill root
      expect(prClaude.bundledSkillRoot).toBe('/home/user/.claude/skills');
      expect(prCodex.bundledSkillRoot).toBe('/home/user/.codex/skills');
      // Agent without capabilities has no skill root
      expect(noCapsAgent.bundledSkillRoot).toBeUndefined();
    });

    it('registration order determines getWithCapability winner', () => {
      // Register codex first in a fresh registry
      const reversed = new AgentRegistry();
      reversed.registerExecution(prCodex);
      reversed.registerExecution(prClaude);
      expect(reversed.getWithCapability('make-pr')).toBe(prCodex);
    });
  });
});
