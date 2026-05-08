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

    it('listWithCapability returns agents in deterministic registration order for fallback chains', () => {
      // Build a registry with 4 agents registered in a specific order
      const reg = new AgentRegistry();
      const agentA = makeExecutionAgent('alpha', { bundledSkillRoot: '/a', bundledSkills: ['make-pr'] });
      const agentB = makeExecutionAgent('bravo', { bundledSkillRoot: '/b', bundledSkills: ['make-pr'] });
      const agentC = makeExecutionAgent('charlie', { bundledSkillRoot: '/c', bundledSkills: ['make-pr'] });
      const agentNoPr = makeExecutionAgent('delta'); // no make-pr capability

      reg.registerExecution(agentA);
      reg.registerExecution(agentB);
      reg.registerExecution(agentNoPr);
      reg.registerExecution(agentC);

      const prAgents = reg.listWithCapability('make-pr');
      // Must be exactly [alpha, bravo, charlie] — delta excluded, order matches registration
      expect(prAgents).toHaveLength(3);
      expect(prAgents[0].name).toBe('alpha');
      expect(prAgents[1].name).toBe('bravo');
      expect(prAgents[2].name).toBe('charlie');

      // Repeated calls must be stable
      const second = reg.listWithCapability('make-pr');
      expect(second.map(a => a.name)).toEqual(prAgents.map(a => a.name));
    });

    it('listWithCapability excludes agents with different skills', () => {
      const reg = new AgentRegistry();
      const prAgent = makeExecutionAgent('pr-only', { bundledSkillRoot: '/pr', bundledSkills: ['make-pr'] });
      const deployAgent = makeExecutionAgent('deploy-only', { bundledSkillRoot: '/deploy', bundledSkills: ['deploy'] });
      const bothAgent = makeExecutionAgent('both', { bundledSkillRoot: '/both', bundledSkills: ['make-pr', 'deploy'] });

      reg.registerExecution(prAgent);
      reg.registerExecution(deployAgent);
      reg.registerExecution(bothAgent);

      const prCapable = reg.listWithCapability('make-pr');
      expect(prCapable.map(a => a.name)).toEqual(['pr-only', 'both']);

      const deployCapable = reg.listWithCapability('deploy');
      expect(deployCapable.map(a => a.name)).toEqual(['deploy-only', 'both']);
    });

    it('getWithCapability and listWithCapability stay consistent after additional registrations', () => {
      const reg = new AgentRegistry();
      const agentA = makeExecutionAgent('a', { bundledSkillRoot: '/a', bundledSkills: ['make-pr'] });
      reg.registerExecution(agentA);

      expect(reg.getWithCapability('make-pr')).toBe(agentA);
      expect(reg.listWithCapability('make-pr')).toEqual([agentA]);

      // Add a second PR-capable agent
      const agentB = makeExecutionAgent('b', { bundledSkillRoot: '/b', bundledSkills: ['make-pr'] });
      reg.registerExecution(agentB);

      // First agent still wins getWithCapability (insertion order preserved)
      expect(reg.getWithCapability('make-pr')).toBe(agentA);
      // listWithCapability now includes both
      expect(reg.listWithCapability('make-pr')).toEqual([agentA, agentB]);
    });
  });
});
